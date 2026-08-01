'use strict';

const Homey = require('homey');
const DevialetClient = require('../../lib/devialet-client');
const sources = require('../../lib/devialet-sources');
const errlog = require('../../lib/errlog');

const POLL_INTERVAL = 15000;

// One tile = one Devialet SYSTEM. For a stereo pair that is both speakers:
// they share playback state and volume, and either can answer for the system,
// so the client below holds every member and retries across them.
class DevialetDevice extends Homey.Device {
  async onInit() {
    this.client = new DevialetClient(this.getStoreValue('members') || [], {
      log: (msg) => errlog.debug(`${this.getName()}: devialet`, msg),
    });
    this.roles = {}; // deviceId -> FrontLeft / FrontRight / Mono

    this.registerCapabilityListener('speaker_playing', (v) => this.client.playback(v ? 'play' : 'pause'));
    this.registerCapabilityListener('speaker_next', () => this.client.playback('next'));
    this.registerCapabilityListener('speaker_prev', () => this.client.playback('previous'));
    this.registerCapabilityListener('volume_mute', (v) => this.client.playback(v ? 'mute' : 'unmute'));
    // Homey's volume_set is 0..1; the API speaks percent.
    this.registerCapabilityListener('volume_set', (v) => this.client.setVolume(v * 100));
    this.registerCapabilityListener('volume_up', () => this.client.volumeUp());
    this.registerCapabilityListener('volume_down', () => this.client.volumeDown());
    this.registerCapabilityListener('devialet_source', (id) => this.selectSource(id));

    await this.refresh();
    this.pollTimer = this.homey.setInterval(() => this.refresh(), POLL_INTERVAL);
  }

  onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }

  // --- discovery: keep the addresses current without needing static IPs ---

  onDiscoveryResult(result) {
    return (this.getStoreValue('members') || [])
      .some((m) => result.id === m.serial || result.txt?.serialNumber === m.serial);
  }

  onDiscoveryAvailable(result) {
    this.trackAddress(result).catch((err) => this.recordError('discovery available', err));
  }

  onDiscoveryAddressChanged(result) {
    this.trackAddress(result).catch((err) => this.recordError('discovery address', err));
  }

  // mDNS is the source of truth for addresses, which is why static IPs are not
  // required: a speaker that moves is re-learned here.
  async trackAddress(result) {
    const serial = result.txt?.serialNumber;
    if (!serial || !result.address) return;

    const members = this.getStoreValue('members') || [];
    const member = members.find((m) => m.serial === serial);
    if (!member || member.address === result.address) return;

    errlog.info(`${this.getName()}: address`, `${serial} moved to ${result.address}`);
    member.address = result.address;
    await this.setStoreValue('members', members);
    this.client.setMembers(members);
    await this.refresh();
  }

  // --- state ---

  async refresh() {
    try {
      const system = await this.client.getSystem();
      this.roles = sources.rolesFromSystem(system);

      const [volume, current] = await Promise.all([
        this.client.getVolume(),
        this.client.getCurrentSource(),
      ]);

      if (typeof volume?.volume === 'number') {
        await this.setCapabilityValue('volume_set', volume.volume / 100).catch(() => {});
      }

      if (current) {
        await this.setCapabilityValue('speaker_playing', current.playingState === 'playing').catch(() => {});
        await this.setCapabilityValue('volume_mute', current.muteState === 'muted').catch(() => {});

        const id = sources.idForSource(current.source, this.roles);
        if (id) await this.setCapabilityValue('devialet_source', id).catch(() => {});

        await this.updateMetadata(current.metadata);
      }

      if (!this.getAvailable()) await this.setAvailable();
      errlog.debug(`${this.getName()}: state`, `volume=${volume?.volume} ${current?.playingState}`);
    } catch (err) {
      // Every member was tried before we get here, so the system really is out
      // of reach — not just one speaker asleep.
      this.recordError('refresh', err);
      await this.setUnavailable(this.homey.__('devialet.unreachable')).catch(() => {});
    }
  }

  async updateMetadata(metadata) {
    if (!metadata) return;
    // Empty strings are normal on a physical input with no metadata; writing
    // them anyway keeps the tile from showing a stale track forever.
    await this.setCapabilityValue('speaker_artist', metadata.artist || '').catch(() => {});
    await this.setCapabilityValue('speaker_album', metadata.album || '').catch(() => {});
    await this.setCapabilityValue('speaker_track', metadata.title || '').catch(() => {});
  }

  // --- input switching ---

  // Playing a source is also what selects it, so this doubles as "switch input".
  async selectSource(id) {
    const list = await this.client.getSources();
    const sourceId = sources.sourceIdFor(id, list?.sources || [], this.roles);

    if (!sourceId) {
      // Happens when the speaker hosting that input is off, or the group was
      // reconfigured — say so instead of failing with an opaque HTTP error.
      throw new Error(this.homey.__('devialet.source_unavailable'));
    }

    await this.client.playSource(sourceId);
    errlog.info(`${this.getName()}: source`, `switched to ${id}`);
    await this.setCapabilityValue('devialet_source', id).catch(() => {});
  }

  // Relative volume change, in percentage points.
  //
  // The device's own volumeUp/volumeDown are locked to a 5% step, which makes a
  // held remote button crawl (~20 presses for the full range) — and each step
  // is a separate HTTP round trip. Reading the volume and writing an absolute
  // value lets a flow pick its own step size, so one button repeat can move
  // 10% instead of 5.
  async stepVolume(delta) {
    const current = await this.client.getVolume();
    if (typeof current?.volume !== 'number') throw new Error('could not read current volume');

    const next = Math.max(0, Math.min(100, current.volume + delta));
    await this.client.setVolume(next);
    await this.setCapabilityValue('volume_set', next / 100).catch(() => {});
    return next;
  }

  recordError(context, err) {
    this.error(context, err);
    errlog.add(`${this.getName()}: ${context}`, err);
  }
}

module.exports = DevialetDevice;
