// Mirror of the NDJSON events emitted by the C++ game outbox.
// Each event is one line written atomically to the outbox file.

export const EventKind = {
  GUEST_ENTRY: "GUEST_ENTRY",
  GUEST_SPEND: "GUEST_SPEND",
  GUEST_EXIT: "GUEST_EXIT",
  VENUE_REGISTERED: "VENUE_REGISTERED",
  VENUE_RENAMED: "VENUE_RENAMED",
  VENUE_REMOVED: "VENUE_REMOVED",
} as const;

export type EventKind = typeof EventKind[keyof typeof EventKind];

interface BaseEvent {
  kind: EventKind;
  seq: number;   // monotonic counter
  ts: number;    // ms since epoch
}

export interface GuestEntryEvent extends BaseEvent {
  kind: "GUEST_ENTRY";
  guestId: number;
  cash: string;   // decimal PARK units
}

export interface GuestSpendEvent extends BaseEvent {
  kind: "GUEST_SPEND";
  guestId: number;
  venueId: number;
  amount: string;
  category: number;
  gameTick: number;
}

export interface GuestExitEvent extends BaseEvent {
  kind: "GUEST_EXIT";
  guestId: number;
}

export interface VenueRegisteredEvent extends BaseEvent {
  kind: "VENUE_REGISTERED";
  venueId: number;
  venueKind: number;
  name: string;
  objectType: string;
}

export interface VenueRenamedEvent extends BaseEvent {
  kind: "VENUE_RENAMED";
  venueId: number;
  newName: string;
}

export interface VenueRemovedEvent extends BaseEvent {
  kind: "VENUE_REMOVED";
  venueId: number;
}

export type OutboxEvent =
  | GuestEntryEvent
  | GuestSpendEvent
  | GuestExitEvent
  | VenueRegisteredEvent
  | VenueRenamedEvent
  | VenueRemovedEvent;
