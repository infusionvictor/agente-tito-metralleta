"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Navegación entre las vistas del agente (Ticker / Ideas / Wheel / Time & Sales /
// Mis Trades / Certeza). Vive en la barra superior de cada página para que moverse
// entre ellas sea un clic, no un enlace perdido.
const TABS = [
  { href: "/", label: "Ticker", icon: "📈" },
  { href: "/ideas", label: "Ideas", icon: "💡" },
  { href: "/wheel", label: "Wheel", icon: "🎡" },
  { href: "/flow", label: "Time & Sales", icon: "⚡" },
  { href: "/trades", label: "Mis Trades", icon: "📝" },
  { href: "/alerts", label: "Certeza", icon: "🎯" },
];

export default function NavTabs({ standalone = false }: { standalone?: boolean }) {
  const pathname = usePathname();

  return (
    <nav className={`nav-tabs ${standalone ? "standalone" : ""}`} aria-label="Secciones">
      {TABS.map((t) => {
        const on = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`nav-tab ${on ? "on" : ""}`}
            aria-current={on ? "page" : undefined}
          >
            <span className="nav-tab-icon" aria-hidden="true">{t.icon}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
