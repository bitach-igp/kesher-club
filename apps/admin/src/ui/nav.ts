// The admin shell's areas (T-0901, T-0615, T-0931): one list for the side navigation.
export interface Area {
  code: string;
  label: string;
  href: string;
}

export const AREAS: readonly Area[] = [
  { code: 'A01', label: 'Customer 360', href: '/customers' },
  { code: 'A02', label: 'Compliance queues', href: '/compliance' },
  { code: 'A03', label: 'Ops queues', href: '/compliance/complaints' },
  { code: 'A04', label: 'Ledger explorer', href: '/ledger' },
  { code: 'A05', label: 'Catalogue and pricing', href: '/catalogue' },
  { code: 'A06', label: 'Plans and niches', href: '/plans' },
  { code: 'A07', label: 'Providers and flags', href: '/providers' },
  { code: 'A08', label: 'CMS and legal', href: '/legal' },
  { code: 'A09', label: 'Institutions', href: '/institutions' },
  { code: 'A12', label: 'Ops queue', href: '/ops' },
];

export const areaLabel = (code: string): string | undefined => AREAS.find((a) => a.code === code)?.label;
