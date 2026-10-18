// The navigation bar on every signed-in page: the console's sections, who is
// signed in, and Sign out. Takes the operator from the page (which got it
// from requireOperator) instead of looking it up itself.

import Link from "next/link";
import type { CurrentOperator } from "@/lib/auth";
import { signOut } from "./login/actions";
import { SubmitButton } from "./dashboard/pending";

const SECTIONS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings/pricing", label: "Pricing" },
  { href: "/settings/operators", label: "Operators" },
  { href: "/audit", label: "Audit log" },
] as const;

export function TopBar({
  operator,
  current,
}: {
  operator: CurrentOperator;
  current: (typeof SECTIONS)[number]["href"] | null;
}) {
  return (
    <nav className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link
          href="/dashboard"
          className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
        >
          Telemetry Chopper
        </Link>
        <ul className="flex flex-wrap items-center gap-1">
          {SECTIONS.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={current === href ? "page" : undefined}
                className={`rounded-md px-2.5 py-1 text-sm ${
                  current === href
                    ? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }`}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Link
            href="/account/password"
            title="Change your password"
            className="max-w-[16rem] truncate text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {operator.name || operator.email}
          </Link>
          <form action={signOut}>
            <SubmitButton className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
              Sign out
            </SubmitButton>
          </form>
        </div>
      </div>
    </nav>
  );
}
