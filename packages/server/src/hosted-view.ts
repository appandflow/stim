import type { DeviceHost } from './device-host.ts';
import type { ClaimHandle } from '@stim-cli/core/ownership-claim';
import { ControlHub, type Controller } from './control.ts';
import { DEFAULT_FRAME_LIMITS, FramePool, type Device, type FrameListener } from './frames.ts';
import type { FrameHint } from './frame-helper.ts';
import type { ControlBeginResult, ProtocolError } from './protocol.ts';

interface HostedView {
  device: Extract<Device, { platform: 'ios' }>;
  frames: FramePool;
  home: string;
  claim: ClaimHandle;
  workspace: string;
  slot: string;
  listeners: Set<FrameListener>;
  closed: boolean;
  unbind: () => void;
  closing?: Promise<void>;
}

export class HostedViews {
  private readonly views = new Map<string, HostedView>();
  private readonly host: DeviceHost;
  private readonly control: ControlHub;
  private readonly env: NodeJS.ProcessEnv;
  private readonly helper: () => string | null;

  constructor(host: DeviceHost, control: ControlHub, env: NodeJS.ProcessEnv, helper: () => string | null) {
    this.host = host;
    this.control = control;
    this.env = env;
    this.helper = helper;
  }

  target(client: string, session: string): HostedView {
    const target = this.host.viewTarget(client, session);
    const existing = this.views.get(session);
    if (existing) {
      if (existing.closed) throw new Error('Hosted capture is stopping; retry after it has closed.');
      if (existing.device.udid !== target.session.device!.udid)
        throw new Error('The hosted device changed; stop this session before retrying.');
      return existing;
    }
    const helper = this.helper();
    if (!helper) throw new Error('Hosted view and input need the stim-frames helper, which this Mac has not built.');
    const device: Extract<Device, { platform: 'ios' }> = {
      platform: 'ios',
      udid: target.session.device!.udid,
      foldable: /\bDuo\b/.test(target.session.device!.name),
    };
    const view: HostedView = {
      device,
      frames: new FramePool(
        { ...this.env, STIM_HOME: target.home },
        { ...DEFAULT_FRAME_LIMITS, lingerMs: 0 },
        () => helper,
        null,
        target.claim,
      ),
      home: target.home,
      claim: target.claim,
      workspace: target.session.workspace,
      slot: target.session.slot,
      listeners: new Set(),
      closed: false,
      unbind: () => {},
    };
    view.unbind = this.host.bindView(client, session, () => this.close(session, view));
    this.views.set(session, view);
    return view;
  }

  subscribe(client: string, session: string, listener: FrameListener, hint: FrameHint): () => void {
    const view = this.target(client, session);
    view.listeners.add(listener);
    const detach = view.frames.subscribe(
      view.device,
      {
        ...listener,
        failed: (message) => {
          void this.close(session, view, message).catch((error: unknown) => {
            process.stderr.write(`Hosted capture close failed: ${(error as Error).message}\n`);
          });
        },
      },
      hint,
    );
    return () => {
      view.listeners.delete(listener);
      detach();
    };
  }

  begin(
    client: string,
    session: string,
    owner: Controller,
    takeOver: boolean,
    connected: () => boolean,
  ): Promise<ControlBeginResult | ProtocolError> {
    const view = this.target(client, session);
    return this.control.beginHosted(
      owner,
      { workspace: view.workspace, platform: 'ios', slot: view.slot, ...(takeOver ? { takeOver: true } : {}) },
      view.home,
      view.device,
      view.frames,
      () => {
        if (!connected() || view.closed) return false;
        try {
          return this.host.viewTarget(client, session).session.device!.udid === view.device.udid;
        } catch {
          return false;
        }
      },
      view.claim,
    );
  }

  private close(session: string, view: HostedView, message = 'The hosted capture session ended.'): Promise<void> {
    if (view.closing) return view.closing;
    view.closed = true;
    view.closing = (async () => {
      for (const listener of view.listeners) listener.failed(message);
      view.listeners.clear();
      await this.control.endDevice(view.device, 'The hosted session ended.');
      await view.frames.close();
      view.unbind();
      if (this.views.get(session) === view) this.views.delete(session);
    })().catch((error: unknown) => {
      delete view.closing;
      throw error;
    });
    return view.closing;
  }
}
