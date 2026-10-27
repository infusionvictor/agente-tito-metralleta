import { describe, expect, it } from "vitest";
import { isAuthorized, isVercelCronAuthorized } from "./cronAuth";

describe("isAuthorized", () => {
  it("autoriza siempre si no hay secret configurado (local, sin CRON_SECRET)", () => {
    expect(isAuthorized(null, undefined)).toBe(true);
    expect(isAuthorized("cualquier-cosa", undefined)).toBe(true);
  });

  it("rechaza si hay secret pero el header no coincide", () => {
    expect(isAuthorized(null, "secreto")).toBe(false);
    expect(isAuthorized("otro-valor", "secreto")).toBe(false);
  });

  it("autoriza si el header coincide exactamente con el secret", () => {
    expect(isAuthorized("secreto", "secreto")).toBe(true);
  });
});

describe("isVercelCronAuthorized", () => {
  it("autoriza siempre si no hay secret configurado", () => {
    expect(isVercelCronAuthorized(null, undefined)).toBe(true);
  });

  it("rechaza sin el prefijo Bearer", () => {
    expect(isVercelCronAuthorized("secreto", "secreto")).toBe(false);
  });

  it("autoriza con el formato Bearer <secret> que manda Vercel Cron", () => {
    expect(isVercelCronAuthorized("Bearer secreto", "secreto")).toBe(true);
  });

  it("rechaza si el secret no coincide", () => {
    expect(isVercelCronAuthorized("Bearer otro", "secreto")).toBe(false);
  });
});
