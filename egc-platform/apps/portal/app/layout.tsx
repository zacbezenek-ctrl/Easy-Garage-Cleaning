import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Easy Garage Cleaning Ops",
  description: "EGC internal operations portal"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">EGC Ops</a>
          <nav>
            <a href="/">Dashboard</a>
            <a href="/leads">Leads</a>
            <a href="/followups">Follow-ups</a>
            <a href="/customers">Customers</a>
            <a href="/jobs">Jobs</a>
            <a href="/pipeline">Pipeline</a>
            <a href="/walkthroughs">Walkthroughs</a>
            <a href="/analytics">Analytics</a>
            <a href="/diagnostics">Diagnostics</a>
          </nav>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
