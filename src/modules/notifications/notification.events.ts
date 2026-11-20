import type { NotificationEvent, NotificationEventPayload } from "./notification.types.js";

export type NotificationEventHandler = (payload: NotificationEventPayload) => Promise<void>;

export class NotificationEventBus {
  private readonly handlers = new Map<NotificationEvent, Set<NotificationEventHandler>>();

  subscribe(event: NotificationEvent, handler: NotificationEventHandler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<NotificationEventHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  async publish(payload: NotificationEventPayload): Promise<void> {
    const handlers = this.handlers.get(payload.event);
    if (!handlers) return;
    await Promise.all([...handlers].map((handler) => handler(payload)));
  }
}

export const notificationEventBus = new NotificationEventBus();
