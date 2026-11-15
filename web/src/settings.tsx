import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createSaveQueue, type SaveStatus } from "./save-queue";

export type Theme = "light" | "dark" | "sepia";

export type Layout = "pages" | "scroll";

export type ReadingSettings = {
  fontSize: number;
  lineHeight: number;
  width: number;
  theme: Theme;
  layout: Layout;
};

export const defaultSettings: ReadingSettings = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light",
  layout: "pages",
};

type Stepped = "fontSize" | "lineHeight" | "width";

const ranges: Record<Stepped, { min: number; max: number; step: number }> = {
  fontSize: { min: 14, max: 28, step: 1 },
  lineHeight: { min: 1.2, max: 2, step: 0.1 },
  width: { min: 28, max: 48, step: 2 },
};

const themes: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "sepia", label: "Sepia" },
];

const layouts: { value: Layout; label: string }[] = [
  { value: "pages", label: "Pages" },
  { value: "scroll", label: "Scroll" },
];

type SettingsState = {
  settings: ReadingSettings;
  // The user's change: it applies at once and is saved.
  setSettings: (settings: ReadingSettings) => void;
  // Fetches the saved settings and applies them, unless the user changed a
  // setting meanwhile or a change is not saved yet. Returns a function that
  // ignores the answer.
  load: () => () => void;
  loadFailed: boolean;
  saveStatus: SaveStatus;
  retry: () => void;
  reset: () => void;
};

const SettingsContext = createContext<SettingsState | null>(null);

async function fetchSettings(): Promise<ReadingSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) {
    throw new Error(`/api/settings answered ${res.status}`);
  }
  return res.json();
}

// keepalive lets a save in flight outlive the page closing or reloading.
async function putSettings(settings: ReadingSettings) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
    keepalive: true,
  });
  if (!res.ok) {
    throw new Error(`/api/settings answered ${res.status}`);
  }
}

// The reading settings and their save queue live at the app level, so moving
// between pages neither drops a save nor loses a change, and the next reader
// opened uses the current settings at once.
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  return (
    <SettingsSession key={generation} reset={() => setGeneration((n) => n + 1)}>
      {children}
    </SettingsSession>
  );
}

function SettingsSession({
  children,
  reset,
}: {
  children: ReactNode;
  reset: () => void;
}) {
  const [settings, setLocal] = useState(defaultSettings);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [loadFailed, setLoadFailed] = useState(false);
  const changes = useRef(0);
  const [queue] = useState(() =>
    createSaveQueue<ReadingSettings>({
      delay: 500,
      send: putSettings,
      onStatus: setSaveStatus,
    }),
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        queue.hidden();
      }
    };
    const onPageHide = () => queue.pagehide();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [queue]);

  const setSettings = useCallback(
    (next: ReadingSettings) => {
      changes.current++;
      setLocal(next);
      queue.change(next);
    },
    [queue],
  );

  const load = useCallback(() => {
    let ignored = false;
    const changesBefore = changes.current;
    const saveOutstanding = queue.status() !== "saved";
    fetchSettings().then(
      (saved) => {
        if (ignored) {
          return;
        }
        setLoadFailed(false);
        if (
          !saveOutstanding &&
          changes.current === changesBefore &&
          queue.status() === "saved"
        ) {
          setLocal(saved);
        }
      },
      () => {
        if (!ignored) {
          setLoadFailed(true);
        }
      },
    );
    return () => {
      ignored = true;
    };
  }, [queue]);

  return (
    <SettingsContext
      value={{
        settings,
        setSettings,
        load,
        loadFailed,
        saveStatus,
        retry: queue.retry,
        reset: () => {
          queue.dispose();
          reset();
        },
      }}
    >
      {children}
    </SettingsContext>
  );
}

export function useReadingSettings(): SettingsState {
  const state = useContext(SettingsContext);
  if (!state) {
    throw new Error("useReadingSettings needs a SettingsProvider");
  }
  return state;
}

export function changesLayout(a: ReadingSettings, b: ReadingSettings) {
  return (
    a.fontSize !== b.fontSize ||
    a.lineHeight !== b.lineHeight ||
    a.width !== b.width ||
    a.layout !== b.layout
  );
}

// Puts the settings on the root element, where the reading page's CSS reads
// them. The style is set through the CSSOM, which the CSP allows.
export function applyToPage(settings: ReadingSettings) {
  const root = document.documentElement;
  root.style.setProperty("--reading-font-size", `${settings.fontSize}px`);
  root.style.setProperty("--reading-line-height", String(settings.lineHeight));
  root.style.setProperty("--reading-width", `${settings.width}rem`);
  root.dataset.readingTheme = settings.theme;
  root.dataset.readingLayout = settings.layout;
}

// Takes the settings off the root element, so other pages look as before.
export function clearFromPage() {
  const root = document.documentElement;
  for (const name of [
    "--reading-font-size",
    "--reading-line-height",
    "--reading-width",
  ]) {
    root.style.removeProperty(name);
  }
  delete root.dataset.readingTheme;
  delete root.dataset.readingLayout;
}

function Stepper({
  name,
  setting,
  format,
}: {
  name: string;
  setting: Stepped;
  format: (value: number) => string;
}) {
  const { settings, setSettings } = useReadingSettings();
  const { min, max, step } = ranges[setting];
  const value = settings[setting];
  const change = (direction: 1 | -1) => {
    const next = Math.round((value + direction * step) * 10) / 10;
    setSettings({
      ...settings,
      [setting]: Math.min(max, Math.max(min, next)),
    });
  };
  const button =
    "h-10 w-10 rounded border border-(--page-rule) text-lg disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-4">
      <span>{name}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${name.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => change(-1)}
          className={button}
        >
          −
        </button>
        <output aria-label={name} className="w-16 text-center">
          {format(value)}
        </output>
        <button
          type="button"
          aria-label={`Increase ${name.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => change(1)}
          className={button}
        >
          +
        </button>
      </div>
    </div>
  );
}

// The reading settings, in a panel fixed to the bottom of the viewport. It
// does not block the page, so the text can be read and scrolled while the
// settings change.
export function SettingsPanel({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { settings, setSettings, loadFailed, saveStatus, retry } =
    useReadingSettings();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      onClose();
    }
  };
  return (
    <dialog
      open
      id={id}
      aria-label="Reading settings"
      onKeyDown={onKeyDown}
      className="fixed inset-x-0 top-auto bottom-0 z-10 m-0 w-full border-t border-(--page-rule) bg-(--panel-bg) p-4 text-(--page-fg) shadow-xl sm:right-4 sm:bottom-4 sm:left-auto sm:w-80 sm:rounded sm:border"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Reading settings</h2>
          <button type="button" onClick={onClose} className="underline">
            Close
          </button>
        </div>
        <Stepper
          name="Font size"
          setting="fontSize"
          format={(v) => `${v} px`}
        />
        <Stepper
          name="Line height"
          setting="lineHeight"
          format={(v) => v.toFixed(1)}
        />
        <Stepper name="Text width" setting="width" format={(v) => `${v} rem`} />
        <fieldset className="flex items-center justify-between gap-4">
          <legend className="float-left">Layout</legend>
          <div className="flex gap-3">
            {layouts.map(({ value, label }) => (
              <label key={value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="reading-layout"
                  value={value}
                  checked={settings.layout === value}
                  onChange={() => setSettings({ ...settings, layout: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex items-center justify-between gap-4">
          <legend className="float-left">Theme</legend>
          <div className="flex gap-3">
            {themes.map(({ value, label }) => (
              <label key={value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="reading-theme"
                  value={value}
                  checked={settings.theme === value}
                  onChange={() => setSettings({ ...settings, theme: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div aria-live="polite" className="flex flex-col gap-1 text-sm">
          {loadFailed && <p>Your saved settings could not be loaded.</p>}
          {saveStatus === "saving" && <p>Saving…</p>}
          {saveStatus === "failed" && (
            <p className="flex items-center gap-2">
              Not saved
              <button type="button" onClick={retry} className="underline">
                Retry
              </button>
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
