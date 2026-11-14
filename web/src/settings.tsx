import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useState,
} from "react";

export type Theme = "light" | "dark" | "sepia";

export type ReadingSettings = {
  fontSize: number;
  lineHeight: number;
  width: number;
  theme: Theme;
};

export const defaultSettings: ReadingSettings = {
  fontSize: 18,
  lineHeight: 1.6,
  width: 38,
  theme: "light",
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

type SettingsState = {
  settings: ReadingSettings;
  setSettings: (settings: ReadingSettings) => void;
};

const SettingsContext = createContext<SettingsState | null>(null);

// The reading settings live at the app level, so moving between pages keeps
// them and the next reader opened uses them.
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(defaultSettings);
  return (
    <SettingsContext value={{ settings, setSettings }}>
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
    a.width !== b.width
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
  const { settings, setSettings } = useReadingSettings();
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
      </div>
    </dialog>
  );
}
