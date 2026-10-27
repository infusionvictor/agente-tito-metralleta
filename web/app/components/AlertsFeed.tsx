"use client";

import AlertsList from "@/app/components/AlertsList";
import type { Alert } from "@/lib/alerts";

/** Versión compacta y colapsable — vive dentro de /trades. La versión completa está en /alerts. */
export default function AlertsFeed({ alerts }: { alerts: Alert[] }) {
  return (
    <details className="detalle" open={alerts.length > 0}>
      <summary>
        Alertas del piloto <span className="muted">({alerts.length})</span>
      </summary>
      <div className="detalle-inner">
        <AlertsList alerts={alerts} />
      </div>
    </details>
  );
}
