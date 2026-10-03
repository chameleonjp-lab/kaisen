import type { GameEvent } from './types';

type ActivityKind = 'lost' | 'returned' | 'victory';
interface Activity { slot: number; kind: ActivityKind; count: number; }
interface ActiveActivity extends Activity { until: number; }
const DISPLAY_SECONDS = 3;
const MAX_VISIBLE = 2;
const validSlot = (slot: number | undefined): slot is number =>
  Number.isInteger(slot) && slot! >= 0 && slot! < 4;

function activityFor(event: GameEvent): Omit<Activity, 'count'> | null {
  if (event.type === 'ally-respawn' && validSlot(event.ownerAllySlot)) {
    return { slot: event.ownerAllySlot, kind: 'returned' };
  }
  if (event.type !== 'kill') return null;
  if (event.targetTeam === 'friendly' && validSlot(event.targetAllySlot)) {
    return { slot: event.targetAllySlot, kind: 'lost' };
  }
  if (event.targetTeam === 'enemy' && event.targetKind === 'aircraft'
    && event.team === 'friendly' && validSlot(event.ownerAllySlot)) {
    return { slot: event.ownerAllySlot, kind: 'victory' };
  }
  return null;
}

function text(activity: Activity): string {
  const descriptions = { lost: 'が戦闘不能 · 40秒後に復帰', returned: 'が戦線へ復帰', victory: 'が敵機を撃墜' };
  return `僚機${activity.slot + 1}${descriptions[activity.kind]}${activity.count > 1 ? ` ×${activity.count}` : ''}`;
}

/** Independent of reload/reinforcement alerts. At most two visible lines and
 * twelve pending (four slots × three kinds) counters; bursts are coalesced,
 * never silently discarded. Totals retain even events on the final game tick.
 */
export class AllyAnnouncements {
  private pending: Activity[] = [];
  private active: ActiveActivity[] = [];
  private lastEventId = 0;
  private totals = Array.from({ length: 4 }, () => ({ lost: 0, returned: 0, victory: 0 }));

  record(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.id <= this.lastEventId) continue;
      this.lastEventId = event.id;
      const activity = activityFor(event);
      if (!activity) continue;
      this.totals[activity.slot][activity.kind]++;
      const queued = this.pending.find(item => item.slot === activity.slot && item.kind === activity.kind);
      if (queued) queued.count++;
      else this.pending.push({ ...activity, count: 1 });
    }
  }

  update(elapsed: number): string[] {
    this.active = this.active.filter(item => item.until > elapsed);
    while (this.active.length < MAX_VISIBLE && this.pending.length) {
      this.active.push({ ...this.pending.shift()!, until: elapsed + DISPLAY_SECONDS });
    }
    return this.active.map(text);
  }

  summary(): string[] {
    return this.totals.flatMap((counts, slot) => counts.lost || counts.returned || counts.victory
      ? [`僚機${slot + 1}：敵機撃墜${counts.victory} · 戦闘不能${counts.lost} · 復帰${counts.returned}`] : []);
  }

  snapshot() {
    return { visible: this.active.map(text), pendingGroups: this.pending.length,
      pendingEvents: this.pending.reduce((sum, item) => sum + item.count, 0), totals: this.totals.map(item => ({ ...item })) };
  }

  clear(): void {
    this.pending = []; this.active = []; this.lastEventId = 0;
    this.totals = Array.from({ length: 4 }, () => ({ lost: 0, returned: 0, victory: 0 }));
  }
}
