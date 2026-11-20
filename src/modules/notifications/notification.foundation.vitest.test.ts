import { describe, expect, it, vi } from "vitest";
import { NotificationEventBus } from "./notification.events.js";
import { createMockNotificationProvider, NotificationProviderError } from "./notification.providers.js";
import { getNotificationTemplate, renderNotificationTemplate } from "./notification.templates.js";

describe("central notification foundation", () => {
  it("publishes events to subscribers and supports unsubscribe", async () => {
    const bus = new NotificationEventBus();
    const handler = vi.fn(async () => undefined);
    const unsubscribe = bus.subscribe("APPOINTMENT_BOOKED", handler);
    await bus.publish({ eventId: "event-1", tenantId: "tenant-1", event: "APPOINTMENT_BOOKED", data: {} });
    unsubscribe();
    await bus.publish({ eventId: "event-2", tenantId: "tenant-1", event: "APPOINTMENT_BOOKED", data: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("renders only supplied template variables in English and Hindi", () => {
    expect(renderNotificationTemplate("Hello {{name}} {{missing}}", { name: "Patient" })).toBe("Hello Patient ");
    expect(getNotificationTemplate("PAYMENT_RECEIVED", "EMAIL", "HI").body).toContain("HospitalOS");
  });

  it("provides deterministic mock provider failures without external delivery", async () => {
    const provider = createMockNotificationProvider({ fail: "transient" });
    await expect(provider.send({ recipient: "masked", subject: null, body: "test" }))
      .rejects.toBeInstanceOf(NotificationProviderError);
  });
});
