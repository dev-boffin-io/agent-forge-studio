'use strict';

// Google Calendar: list calendars/events and create/update/delete events.

const { authHeader, requestJson } = require('./api');

const CALENDAR = 'https://www.googleapis.com/calendar/v3';

function eventTime(value, timeZone) {
  if (!value) return undefined;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date/time: ${s} (use ISO 8601 or YYYY-MM-DD)`);
  return { dateTime: d.toISOString(), ...(timeZone ? { timeZone: String(timeZone) } : {}) };
}

function eventBody({ summary, description, location, start, end, timeZone, attendees, recurrence, status } = {}) {
  const body = {};
  if (summary !== undefined) body.summary = String(summary);
  if (description !== undefined) body.description = String(description);
  if (location !== undefined) body.location = String(location);
  if (start !== undefined) body.start = eventTime(start, timeZone);
  if (end !== undefined) body.end = eventTime(end, timeZone);
  if (recurrence !== undefined) body.recurrence = Array.isArray(recurrence) ? recurrence.map(String) : [String(recurrence)];
  if (status !== undefined) body.status = String(status);
  if (attendees !== undefined) {
    body.attendees = (Array.isArray(attendees) ? attendees : [attendees]).map((a) => {
      if (typeof a === 'string') return { email: a };
      return { email: String(a.email || ''), optional: !!a.optional };
    }).filter((a) => a.email);
  }
  return body;
}

async function listCalendars() {
  const headers = await authHeader();
  const data = await requestJson(`${CALENDAR}/users/me/calendarList`, { headers }, 'calendar list');
  return { calendars: (data && data.items) || [] };
}

async function listEvents({
  calendarId = 'primary', timeMin, timeMax, maxResults = 25, q, singleEvents = true, orderBy = 'startTime',
} = {}) {
  const headers = await authHeader();
  const u = new URL(`${CALENDAR}/calendars/${encodeURIComponent(String(calendarId || 'primary'))}/events`);
  if (timeMin) u.searchParams.set('timeMin', new Date(timeMin).toISOString());
  if (timeMax) u.searchParams.set('timeMax', new Date(timeMax).toISOString());
  if (q) u.searchParams.set('q', String(q));
  u.searchParams.set('maxResults', String(Math.max(1, Math.min(Number(maxResults) || 25, 2500))));
  u.searchParams.set('singleEvents', String(singleEvents !== false));
  u.searchParams.set('orderBy', String(orderBy || 'startTime'));
  const data = await requestJson(u, { headers }, 'calendar events');
  return { calendarId, events: (data && data.items) || [], nextPageToken: (data && data.nextPageToken) || null };
}

async function getEvent({ calendarId = 'primary', eventId } = {}) {
  if (!eventId) throw new Error('eventId is required');
  const headers = await authHeader();
  return requestJson(`${CALENDAR}/calendars/${encodeURIComponent(String(calendarId || 'primary'))}/events/${encodeURIComponent(String(eventId))}`, { headers }, 'calendar event');
}

async function createEvent({
  calendarId = 'primary', summary, description, location, start, end, timeZone, attendees, recurrence, sendUpdates = 'none',
} = {}) {
  if (!summary || !String(summary).trim()) throw new Error('summary is required');
  if (!start || !end) throw new Error('start and end are required');
  const headers = await authHeader();
  const u = new URL(`${CALENDAR}/calendars/${encodeURIComponent(String(calendarId || 'primary'))}/events`);
  if (sendUpdates) u.searchParams.set('sendUpdates', String(sendUpdates));
  return requestJson(u, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: eventBody({ summary, description, location, start, end, timeZone, attendees, recurrence }),
  }, 'calendar create event');
}

async function updateEvent({
  calendarId = 'primary', eventId, summary, description, location, start, end, timeZone, attendees, recurrence, status, sendUpdates = 'none',
} = {}) {
  if (!eventId) throw new Error('eventId is required');
  const headers = await authHeader();
  const u = new URL(`${CALENDAR}/calendars/${encodeURIComponent(String(calendarId || 'primary'))}/events/${encodeURIComponent(String(eventId))}`);
  if (sendUpdates) u.searchParams.set('sendUpdates', String(sendUpdates));
  return requestJson(u, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: eventBody({ summary, description, location, start, end, timeZone, attendees, recurrence, status }),
  }, 'calendar update event');
}

async function deleteEvent({ calendarId = 'primary', eventId, sendUpdates = 'none' } = {}) {
  if (!eventId) throw new Error('eventId is required');
  const headers = await authHeader();
  const u = new URL(`${CALENDAR}/calendars/${encodeURIComponent(String(calendarId || 'primary'))}/events/${encodeURIComponent(String(eventId))}`);
  if (sendUpdates) u.searchParams.set('sendUpdates', String(sendUpdates));
  await requestJson(u, { method: 'DELETE', headers }, 'calendar delete event');
  return { ok: true, calendarId, eventId };
}

module.exports = {
  CALENDAR, listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent, eventTime,
};
