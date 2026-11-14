import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

type Credentials = { username: string; password: string };

const messages: Record<number, string> = {
  401: "Wrong username or password.",
  409: "Setup has already run. Sign in instead.",
};

// Posts the credentials and returns the error to show, or null on success.
async function postCredentials(
  url: string,
  credentials: Credentials,
): Promise<string | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  if (res.ok) {
    return null;
  }
  return (
    messages[res.status] ??
    `Something went wrong (${res.status}). Please try again.`
  );
}

async function fetchMe(): Promise<{ username: string }> {
  const res = await fetch("/api/me");
  if (!res.ok) {
    throw new Error(`/api/me answered ${res.status}`);
  }
  return res.json();
}

function CredentialsForm({
  title,
  submitLabel,
  newPassword,
  submit,
}: {
  title: string;
  submitLabel: string;
  newPassword: boolean;
  submit: (credentials: Credentials) => Promise<string | null>;
}) {
  const navigate = useNavigate();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    try {
      const failure = await submit({
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      setError(failure);
      if (failure === null) {
        await navigate({ to: "/" });
      }
    } catch {
      setError("tomeshelf could not be reached. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto flex max-w-sm flex-col gap-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <label htmlFor={`${id}-username`} className="flex flex-col gap-1">
        Username
        <input
          id={`${id}-username`}
          name="username"
          autoComplete="username"
          required
          className="rounded border border-stone-300 px-2 py-1"
        />
      </label>
      <label htmlFor={`${id}-password`} className="flex flex-col gap-1">
        Password
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          autoComplete={newPassword ? "new-password" : "current-password"}
          required
          className="rounded border border-stone-300 px-2 py-1"
        />
      </label>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-stone-900 px-3 py-1.5 text-stone-50 disabled:opacity-60"
      >
        {submitLabel}
      </button>
    </form>
  );
}

export function SetupPage() {
  return (
    <CredentialsForm
      title="Create the admin account"
      submitLabel="Create admin"
      newPassword
      submit={(credentials) => postCredentials("/api/setup", credentials)}
    />
  );
}

export function SignInPage() {
  return (
    <CredentialsForm
      title="Sign in"
      submitLabel="Sign in"
      newPassword={false}
      submit={(credentials) => postCredentials("/api/session", credentials)}
    />
  );
}

export function AccountBar() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: fetchMe });

  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setError(null);
    try {
      const res = await fetch("/api/session", { method: "DELETE" });
      if (!res.ok) {
        setError(`Could not sign out (${res.status}). Please try again.`);
        return;
      }
    } catch {
      setError("tomeshelf could not be reached. Please try again.");
      return;
    }
    queryClient.clear();
    await navigate({ to: "/signin" });
  }

  return (
    <div className="flex items-center gap-4">
      {me.data && <p>Signed in as {me.data.username}</p>}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={signOut}
        className="rounded border border-stone-300 px-3 py-1.5"
      >
        Sign out
      </button>
    </div>
  );
}
