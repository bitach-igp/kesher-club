// Marketing and chrome copy, English and Hebrew (T-0048). Both languages are always in the page; the visitor's choice only hides one.
import type { Lang } from './legal.ts';

export type { Lang };

export const COPY = {
  en: {
    brand: 'Kesher Club',
    tagline: 'A membership for students in Israel, funded by their families: a dollar and shekel wallet and card, and a help line at any hour.',
    support: 'Contact support',
    legal: 'Legal documents',
    legalIntro: 'The texts in force. Each page shows the version and the date it came into force.',
    version: 'Version',
    inForce: 'In force from',
    fingerprint: 'Text fingerprint (SHA-256)',
    supportTitle: 'Support',
    supportBody: 'Write to us and we will answer by email. For anything urgent, use the help line inside the app.',
    skip: 'Skip to the content',
    home: 'Home',
    langName: 'English',
  },
  he: {
    brand: 'Kesher Club',
    tagline: 'חברות לתלמידים בישראל, במימון המשפחה: ארנק וכרטיס בדולר ובשקל, וקו עזרה בכל שעה.',
    support: 'פנייה לתמיכה',
    legal: 'מסמכים משפטיים',
    legalIntro: 'הנוסחים שבתוקף. כל עמוד מציג את הגרסה ואת התאריך שבו נכנסה לתוקף.',
    version: 'גרסה',
    inForce: 'בתוקף מתאריך',
    fingerprint: 'טביעת אצבע של הנוסח (SHA-256)',
    supportTitle: 'תמיכה',
    supportBody: 'כתבו לנו ונענה בדואר אלקטרוני. בדבר דחוף, השתמשו בקו העזרה שבאפליקציה.',
    skip: 'דלג לתוכן',
    home: 'דף הבית',
    langName: 'עברית',
  },
} as const satisfies Record<Lang, Record<string, string>>;

export const DIR: Record<Lang, 'ltr' | 'rtl'> = { en: 'ltr', he: 'rtl' };
