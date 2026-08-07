"use client";

import { useEffect, useState } from "react";
import { THETA_BUDGET_PCT, budgetsOf, type RiskProfile } from "@/lib/risk";

const KEY_ACCOUNT = "tito.risk.accountSize";
const KEY_TOLERANCE = "tito.risk.tolerancePct";

export const DEFAULT_PROFILE: RiskProfile = { accountSize: 10_000, tolerancePct: 4 };

const money = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});

/** Lee el perfil de localStorage. Solo cliente — el saldo nunca llega al servidor. */
export function loadProfile(): RiskProfile {
  if (typeof window === "undefined") return DEFAULT_PROFILE;
  const account = Number(window.localStorage.getItem(KEY_ACCOUNT));
  const tolerance = Number(window.localStorage.getItem(KEY_TOLERANCE));
  return {
    accountSize: Number.isFinite(account) && account > 0 ? account : DEFAULT_PROFILE.accountSize,
    tolerancePct:
      Number.isFinite(tolerance) && tolerance > 0 ? tolerance : DEFAULT_PROFILE.tolerancePct,
  };
}

export default function RiskProfileCard({
  profile,
  onChange,
}: {
  profile: RiskProfile;
  onChange: (p: RiskProfile) => void;
}) {
  // El input se edita como texto para no pelear con el 0 inicial al teclear.
  const [draft, setDraft] = useState(String(profile.accountSize));

  useEffect(() => {
    setDraft(String(profile.accountSize));
  }, [profile.accountSize]);

  const commitAccount = (raw: string) => {
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    const accountSize = Number.isFinite(n) && n > 0 ? n : 0;
    window.localStorage.setItem(KEY_ACCOUNT, String(accountSize));
    onChange({ ...profile, accountSize });
  };

  const commitTolerance = (tolerancePct: number) => {
    window.localStorage.setItem(KEY_TOLERANCE, String(tolerancePct));
    onChange({ ...profile, tolerancePct });
  };

  const budgets = budgetsOf(profile);

  return (
    <section className="risk-card">
      <div className="risk-head">
        <h2>Tu perfil de riesgo</h2>
        <span className="muted">
          Se guarda solo en este navegador — tu saldo nunca sale de tu equipo.
        </span>
      </div>

      <div className="risk-controls">
        <label className="risk-field">
          <span>Tamaño de cuenta</span>
          <input
            className="risk-input"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commitAccount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label="Tamaño de cuenta en dólares"
          />
        </label>

        <label className="risk-field grow">
          <span>
            Riesgo por trade — <strong>{profile.tolerancePct}%</strong>
          </span>
          <input
            className="risk-slider"
            type="range"
            min={1}
            max={50}
            step={0.5}
            value={profile.tolerancePct}
            onChange={(e) => commitTolerance(Number(e.target.value))}
            aria-label="Tolerancia al riesgo como porcentaje de la cuenta"
          />
          <span className="risk-scale">
            <span>conservador 1%</span>
            <span>agresivo 50%</span>
          </span>
        </label>
      </div>

      <div className="risk-budgets">
        <div>
          <span className="muted">Capital máximo por trade</span>
          <strong>{money.format(budgets.premium)}</strong>
        </div>
        <div>
          <span className="muted">Máxima quema de theta ({THETA_BUDGET_PCT}%)</span>
          <strong>{money.format(budgets.theta)}</strong>
        </div>
      </div>

      <p className="risk-note">
        Los números de abajo son un <strong>techo</strong>, no una sugerencia de compra. El
        límite de theta sale de la banda del documento de Inusualidad: un contrato que pierde
        más del {THETA_BUDGET_PCT}% de su valor al día se descarta por lotería.
      </p>
    </section>
  );
}
