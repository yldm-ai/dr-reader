import type { PageFlip } from '../PageFlip.ts';

/**
 * Data type passed to the event handler
 */
export type DataType = number | string | boolean | object | null;

/**
 * Type of object in event handlers
 */
export interface WidgetEvent {
    data: DataType;
    object: PageFlip;
}

type EventCallback = (e: WidgetEvent) => void;

/**
 * A class implementing a basic event model
 */
export abstract class EventObject {
    private events = new Map<string, EventCallback[]>();

    /**
     * Add new event handler
     */
    public on(eventName: string, callback: EventCallback): EventObject {
        const callbacks = this.events.get(eventName);
        if (callbacks) callbacks.push(callback);
        else this.events.set(eventName, [callback]);

        return this;
    }

    /**
     * Removing all handlers from an event
     */
    public off(event: string): void {
        this.events.delete(event);
    }

    protected trigger(eventName: string, app: PageFlip, data: DataType = null): void {
        for (const callback of this.events.get(eventName) ?? []) {
            callback({ data, object: app });
        }
    }
}
