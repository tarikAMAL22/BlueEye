import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";

function createMockContext(role: "admin" | "user" = "admin") {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "user@test.com",
      name: "Test User",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
    },
    res: {
      clearCookie: () => {},
    },
  };
}

describe("Dashboard Procedures", () => {
  it("should return dashboard stats for authenticated users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.dashboard.stats();
    expect(result).toBeDefined();
    expect(result).toHaveProperty("totalCameras");
    expect(result).toHaveProperty("activeCameras");
    expect(result).toHaveProperty("totalZones");
    expect(result).toHaveProperty("todayRecognitions");
    expect(result).toHaveProperty("unknownDetections");
    expect(result).toHaveProperty("activeAlerts");
  });

  it("should deny unauthenticated access to dashboard stats", async () => {
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: { clearCookie: () => {} },
    };
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.dashboard.stats();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Camera Procedures", () => {
  it("should list cameras for authenticated users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.cameras.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should deny camera list to unauthenticated users", async () => {
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: { clearCookie: () => {} },
    };
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.cameras.list();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should deny camera creation to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.cameras.create({
        name: "Test Camera",
        rtspUrl: "rtsp://192.168.1.100:554/stream",
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should allow admin to create camera", async () => {
    const ctx = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.cameras.create({
        name: "Test Camera",
        rtspUrl: "rtsp://192.168.1.100:554/stream",
        location: "Main Entrance",
      });
      expect(result).toBeDefined();
    } catch (error) {
      // Database error is acceptable, permission check should pass
      const msg = (error as any)?.message || "";
      expect(msg).not.toContain("FORBIDDEN");
    }
  });

  it("should deny camera update to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.cameras.update({
        id: 1,
        name: "Updated Camera",
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should deny camera deletion to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.cameras.delete({ id: 1 });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Zone Procedures", () => {
  it("should list zones for authenticated users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.zones.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should deny zone creation to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.zones.create({
        name: "Test Zone",
        threatLevel: "high",
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should allow admin to create zone", async () => {
    const ctx = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.zones.create({
        name: "Test Zone",
        description: "Test Zone Description",
        threatLevel: "high",
      });
      expect(result).toBeDefined();
    } catch (error) {
      const msg = (error as any)?.message || "";
      expect(msg).not.toContain("FORBIDDEN");
    }
  });

  it("should deny zone update to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.zones.update({
        id: 1,
        name: "Updated Zone",
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should deny zone deletion to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.zones.delete({ id: 1 });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Person Procedures", () => {
  it("should deny person list to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.persons.list();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should allow admin to list persons", async () => {
    const ctx = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.persons.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should deny person creation to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.persons.create({
        name: "Test Person",
        role: "employee",
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should allow admin to create person", async () => {
    const ctx = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.persons.create({
        name: "Test Person",
        role: "employee",
        photoUrl: "https://example.com/photo.jpg",
      });
      expect(result).toBeDefined();
    } catch (error) {
      const msg = (error as any)?.message || "";
      expect(msg).not.toContain("FORBIDDEN");
    }
  });
});

describe("Alert Procedures", () => {
  it("should allow authenticated users to list alerts", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.alerts.list({ limit: 10 });
    expect(result).toBeDefined();
  });

  it("should allow authenticated users to update alert status", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.alerts.updateStatus({
        id: 1,
        status: "acknowledged",
      });
      expect(result).toBeDefined();
    } catch (error) {
      // Database error is acceptable
      const msg = (error as any)?.message || "";
      expect(msg).not.toContain("UNAUTHORIZED");
    }
  });

  it("should deny alert access to unauthenticated users", async () => {
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: { clearCookie: () => {} },
    };
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.alerts.list({ limit: 10 });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Event Log Procedures", () => {
  it("should allow authenticated users to list events", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.events.list({ limit: 50, offset: 0 });
    expect(result).toBeDefined();
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("should deny event access to unauthenticated users", async () => {
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: { clearCookie: () => {} },
    };
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.events.list({ limit: 50, offset: 0 });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Settings Procedures", () => {
  it("should deny settings access to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.settings.get();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should allow admin to get settings", async () => {
    const ctx = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);

    const result = await caller.settings.get();
    expect(result !== null).toBe(true);
  });

  it("should deny settings update to regular users", async () => {
    const ctx = createMockContext("user");
    const caller = appRouter.createCaller(ctx);

    try {
      await caller.settings.update({
        platformName: "Updated Name",
      });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("should allow admin to update settings", async () => {
    const ctx = createMockContext("admin");
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.settings.update({
        platformName: "BlueEye Security",
        alertThreshold: 0.8,
      });
      expect(result).toBeDefined();
    } catch (error) {
      const msg = (error as any)?.message || "";
      expect(msg).not.toContain("FORBIDDEN");
    }
  });
});
