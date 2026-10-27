// GET /api/alerts — feed de lo que abrió el piloto automático. Más reciente primero.

import { loadAlerts } from "@/lib/alertsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit")) || 30;
  const alerts = await loadAlerts();
  return Response.json({ alerts: alerts.slice(0, limit) });
}
