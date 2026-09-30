import { createContext } from 'react';

/** Answers where a stored drawing is served, on its own origin (architecture §11); throws when it cannot be found. */
export type LocateMockup = (mockupId: string) => Promise<string>;

export const browserLocateMockup: LocateMockup = async (mockupId) => {
  const response = await fetch(`/api/mockups/${encodeURIComponent(mockupId)}`);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== 'string') {
    throw new Error('The drawing has no address.');
  }
  return body.url;
};

export const MockupLocatorContext =
  createContext<LocateMockup>(browserLocateMockup);
