// The console lives at /dashboard; src/proxy.ts has already sent visitors
// without a session to /login before this runs.

import { redirect } from "next/navigation";

export default function Home() {
  redirect("/dashboard");
}
