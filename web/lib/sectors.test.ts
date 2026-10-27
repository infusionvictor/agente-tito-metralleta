import { describe, expect, it } from "vitest";
import { sectorFor, sectorPeers, SECTOR_GROUPS } from "./sectors";

describe("SECTOR_GROUPS", () => {
  it("cada grupo tiene al menos 3 líderes conocidos", () => {
    for (const g of SECTOR_GROUPS) {
      expect(g.leaders.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("no repite el mismo par de palabras clave en dos grupos distintos", () => {
    const seen = new Set<string>();
    for (const g of SECTOR_GROUPS) {
      for (const k of g.keywords) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe("sectorFor", () => {
  it("mapea semiconductores por el sic_description real de Massive", () => {
    expect(sectorFor("SEMICONDUCTORS & RELATED DEVICES")?.name).toBe("Semiconductores");
  });

  it("mapea software empresarial", () => {
    expect(sectorFor("SERVICES-PREPACKAGED SOFTWARE")?.name).toBe("Software empresarial");
  });

  it("no inventa un grupo para un sector no mapeado", () => {
    expect(sectorFor("BLANK CHECKS")).toBeNull();
  });

  it("sin sic_description no rompe, devuelve null", () => {
    expect(sectorFor(null)).toBeNull();
  });
});

describe("sectorPeers", () => {
  it("excluye al propio ticker analizado de sus pares", () => {
    const peers = sectorPeers("SEMICONDUCTORS & RELATED DEVICES", "NVDA");
    expect(peers).not.toContain("NVDA");
    expect(peers.length).toBeGreaterThan(0);
  });

  it("sin grupo mapeado devuelve lista vacía, no undefined", () => {
    expect(sectorPeers("BLANK CHECKS", "XYZ")).toEqual([]);
  });
});
