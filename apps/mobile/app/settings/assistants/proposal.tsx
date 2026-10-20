// M35 assistant proposal (T-1012): the waiting proposals, and the one opened in the member's own words,
// with the purse, what the recipient receives, the assistant, the time left, and the assistant's note set
// apart as untrusted text. Approve takes the passkey; decline does not; an expired one offers neither.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { fromWire, uuidv7 } from '@kesher/domain';
import { useApi } from '../../../src/api.ts';
import { useNow } from '../../../src/clock.ts';
import { Banner, Button, Card, ListRow, Screen, Skeleton, Txt } from '../../../src/components/index.ts';
import { t, useLocale } from '../../../src/i18n.ts';
import { useStore } from '../../../src/model.ts';
import { useParams } from '../../../src/navigation.ts';
import { useTheme } from '../../../src/theme.ts';
import { actionable, createProposalModel, fmt, recipientText, sentence, timeLeft, type ProposalModel } from './proposal.model.ts';

export function useProposalModel(): ProposalModel {
  const api = useApi();
  const now = useNow();
  return useMemo(() => createProposalModel({ proposals: api.proposals, pay: api.pay, newKey: uuidv7, now }), [api, now]);
}

export default function ProposalScreen() {
  const id = useParams()['id'];
  return <ProposalView model={useProposalModel()} {...(id ? { initialId: id } : {})} />;
}

export function ProposalView({ model, initialId }: { model: ProposalModel; initialId?: string }) {
  const s = useStore(model.store);
  const locale = useLocale();
  const now = useNow()();
  const th = useTheme();
  useEffect(() => {
    void model.load().then(() => (initialId ? model.open(initialId) : undefined));
  }, [model, initialId]);

  if (s.mode === 'loading' && !s.current) {
    return (
      <Screen title={t('proposal.title', locale)} testID="screen-proposal">
        <Skeleton />
      </Screen>
    );
  }

  const p = s.current;
  const canAct = actionable(p, now) && !s.approved;
  const footer = canAct ? (
    <View style={{ gap: th.space[2] }}>
      <Button label={t('proposal.approve', locale)} onPress={() => void model.approve()} loading={s.busy} testID="proposal-approve" />
      <Button label={t('proposal.decline', locale)} variant="secondary" onPress={() => void model.decline()} disabled={s.busy} testID="proposal-decline" />
    </View>
  ) : undefined;

  const left = p ? timeLeft(p, now) : undefined;
  const words = p ? sentence(p, locale) : undefined;
  const done = s.approved && p ? (p.kind === 'send' ? t('proposal.approved', locale, { amount: p.amount ? fmt(fromWire(p.amount), locale) : '', to: recipientText(p) }) : p.kind === 'load' ? t('proposal.approvedLoad', locale, { amount: p.amount ? fmt(fromWire(p.amount), locale) : '' }) : t('proposal.approvedOther', locale)) : undefined;

  return (
    <Screen title={t('proposal.title', locale)} subtitle={t('proposal.subtitle', locale)} testID="screen-proposal" footer={footer}>
      {s.needsStepUp ? <Banner tone="info" body={t('proposal.stepUp', locale)} testID="proposal-stepup" /> : null}
      {s.error ? <Banner tone="danger" body={t(s.error.key, locale, s.error.vars)} testID="proposal-error" /> : null}
      {s.notice ? <Banner tone="success" body={t(s.notice.key, locale, s.notice.vars)} testID="proposal-notice" /> : null}
      {done ? <Banner tone="success" body={done} testID="proposal-done" /> : null}

      {p && words ? (
        <Card testID="proposal-card">
          <Txt variant="title2" testID="proposal-sentence">{t(words.key, locale, words.vars)}</Txt>
          {p.amount ? <Txt tone="secondary">{t('proposal.purse', locale, { currency: p.amount.currency })}</Txt> : null}
          {s.preview && p.amount && s.preview.received.currency !== p.amount.currency ? <Txt tone="secondary" testID="proposal-receives">{t('proposal.receives', locale, { received: fmt(fromWire(s.preview.received), locale) })}</Txt> : null}
          <Txt variant="caption" tone="secondary" testID="proposal-assistant">{p.untrusted.clientName ? t('proposal.from', locale, { assistant: p.untrusted.clientName }) : t('proposal.fromUnknown', locale)}</Txt>
          {actionable(p, now) && left ? <Txt variant="caption" tone="secondary" testID="proposal-time-left">{left.h > 0 ? t('proposal.timeLeft', locale, left) : t('proposal.minutesLeft', locale, { m: left.m })}</Txt> : null}
          {!actionable(p, now) && !s.approved && p.status !== 'rejected' ? <Banner tone="warning" body={t('proposal.expired', locale)} testID="proposal-expired" /> : null}
        </Card>
      ) : null}
      {p?.untrusted.note ? (
        <Card testID="proposal-note">
          <Txt variant="caption" tone="secondary">{t('proposal.note.title', locale)}</Txt>
          <Txt testID="proposal-note-text">{p.untrusted.note}</Txt>
        </Card>
      ) : null}

      {!p ? (
        s.items.length === 0 ? (
          <Txt tone="secondary" testID="proposal-none">{t('proposal.none', locale)}</Txt>
        ) : (
          <Card>
            {s.items.map((item, i) => {
              const w = sentence(item, locale);
              return <ListRow key={item.id} title={t(w.key, locale, w.vars)} subtitle={item.untrusted.clientName ?? ''} onPress={() => void model.open(item.id)} last={i === s.items.length - 1} testID={`proposal-row-${item.id}`} />;
            })}
          </Card>
        )
      ) : null}
    </Screen>
  );
}
