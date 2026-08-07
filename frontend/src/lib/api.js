/**
 * API client.
 *
 * Every request goes through here so three things happen consistently:
 *
 *   1. The Supabase access token is attached (fetched fresh each call —
 *      supabase-js refreshes it in the background, so reading it from a
 *      variable would eventually send a stale token).
 *   2. Errors become thrown ApiError objects instead of silent `ok: false`
 *      responses that callers forget to check.
 *   3. Field-level validation errors from Zod stay attached, so forms can
 *      show messages next to the right input.
 */

import { getAccessToken } from './supabase.js';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  /** `{ description: 'Too short.' }` — keyed by field, for form display. */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return this.details.reduce(
      (acc, d) => (d.field ? { ...acc, [d.field]: d.message } : acc),
      {}
    );
  }

  get isAuthError() {
    return this.status === 401;
  }
}

const request = async (method, path, { body, params, auth = true, signal } = {}) => {
  const url = new URL(`${BASE_URL}${path}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      // Skip empty filters rather than sending `?status=`
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // AbortError is deliberate (component unmounted) — let callers ignore it
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Could not reach the server. Check your connection.');
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body means a proxy or crash page, not our API
      throw new ApiError(response.status, 'Unexpected response from the server.');
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error || `Request failed (${response.status}).`,
      data?.details ?? null
    );
  }

  return data;
};

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  delete: (path, options) => request('DELETE', path, options),
};

// ------------------------------------------------------------
// Endpoint helpers
//
// Thin named wrappers so components don't hardcode URLs — renaming a
// route becomes a one-line change here.
// ------------------------------------------------------------

export const authApi = {
  checkEmail: (email) => api.post('/api/auth/check-email', { email }, { auth: false }),
  signup: (payload) => api.post('/api/auth/signup', payload, { auth: false }),
  me: (options) => api.get('/api/auth/me', options),
  updateMe: (payload) => api.patch('/api/auth/me', payload),
};

export const ticketApi = {
  list: (params, options) => api.get('/api/tickets', { ...options, params }),
  stats: (options) => api.get('/api/tickets/stats', options),
  get: (id, options) => api.get(`/api/tickets/${id}`, options),
  timeline: (id, options) => api.get(`/api/tickets/${id}/timeline`, options),
  create: (payload) => api.post('/api/tickets', payload),
  update: (id, payload) => api.patch(`/api/tickets/${id}`, payload),
  remove: (id) => api.delete(`/api/tickets/${id}`),

  setStatus: (id, status, note) => api.patch(`/api/tickets/${id}/status`, { status, note }),
  assign: (id, assignedToId) => api.patch(`/api/tickets/${id}/assign`, { assignedToId }),
  flag: (id, isFlagged, reason) => api.patch(`/api/tickets/${id}/flag`, { isFlagged, reason }),
  toggleVote: (id) => api.post(`/api/tickets/${id}/vote`),

  comments: (id, options) => api.get(`/api/tickets/${id}/comments`, options),
  addComment: (id, body, isInternal = false) =>
    api.post(`/api/tickets/${id}/comments`, { body, isInternal }),
  updateComment: (id, commentId, body) =>
    api.patch(`/api/tickets/${id}/comments/${commentId}`, { body }),
  deleteComment: (id, commentId) => api.delete(`/api/tickets/${id}/comments/${commentId}`),
};

export const departmentApi = {
  list: (options) => api.get('/api/departments', { ...options, auth: false }),
  listAll: (options) => api.get('/api/departments', { ...options, params: { includeInactive: true } }),
  create: (payload) => api.post('/api/departments', payload),
  update: (id, payload) => api.patch(`/api/departments/${id}`, payload),
  remove: (id) => api.delete(`/api/departments/${id}`),
};
