// Public support contacts (help line, WhatsApp, emergency). Content, not secrets; still provided
// by the app shell so no screen hard-codes a number.
import { createContext, useContext } from 'react';

export interface SupportContacts {
  /** E.164 */
  helpLine: string;
  /** E.164, used for https://wa.me/<digits> */
  whatsapp: string;
  /** E.164 */
  emergency: string;
  faqUrl: string;
}

export const SupportContext = createContext<SupportContacts | undefined>(undefined);
export const SupportProvider = SupportContext.Provider;
export function useSupport(): SupportContacts {
  const s = useContext(SupportContext);
  if (!s) throw new Error('SupportProvider is missing');
  return s;
}

export const telUrl = (e164: string): string => `tel:${e164}`;
export const whatsappUrl = (e164: string): string => `https://wa.me/${e164.replace(/\D/g, '')}`;
