// Date coercers shared by the API's row mappers: Postgres drivers hand back a Date or an ISO string depending on the
// column and client, and the wire format wants one shape.

/** Any timestamp-ish value as a full ISO-8601 string. */
export const iso = (v: string | Date): string => new Date(v).toISOString();

/** Any date-ish value as `yyyy-mm-dd` (a string is cut, a Date is read in UTC). */
export const day = (v: string | Date): string => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));
