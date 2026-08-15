/**
 * The API's Redis connection, and the broadcast emitter built on it.
 *
 * **This process owns no Socket.io server.** It writes through
 * `services/messaging` like the gateway does, and then has to reach clients that
 * are connected to a gateway in a different process. `@socket.io/redis-emitter`
 * publishes onto the same channels `@socket.io/redis-adapter` subscribes to, so a
 * `channel.updated` emitted here arrives at every replica.
 *
 * That is also why the emitter is wrapped in `ChannelBroadcast` rather than used
 * directly: a REST rename and a socket send are two writes that must produce the
 * same event shape in the same room, and two hand-written mappings disagree
 * eventually. The failure is silent -- the write succeeds, the emit succeeds, and
 * the other person's client simply stops updating.
 *
 * One connection, not two. Unlike the gateway, this process never subscribes, so
 * it never puts a client into subscriber mode and never needs a second one.
 */
import { ChannelBroadcast } from '@chat/shared';
import { Emitter } from '@socket.io/redis-emitter';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  readonly broadcast: ChannelBroadcast;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = new Redis(config.redisUrl, {
      // Fail rather than queue. The default buffers commands issued before the
      // connection is up and replays them, which would let a health check pass
      // against a Redis that is not there.
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    // Attached in the constructor, before anything can connect. ioredis emits
    // `error` on a blip, and an EventEmitter with no `error` listener throws,
    // which in Node is an uncaught exception that takes the whole API down
    // because Redis hiccuped for 200ms.
    this.client.on('error', (error) => {
      console.error('[api] redis error', error);
    });

    this.broadcast = new ChannelBroadcast(new Emitter(this.client), {
      // A failed emit must not fail a write that already committed. The row is in
      // Postgres; a client that missed the frame notices the gap and catches up.
      onFailure: (event, error) => {
        console.error(`[api] broadcast failed for ${event}`, error);
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    // `quit`, not `disconnect`: it waits for in-flight replies, so a broadcast
    // issued microseconds before shutdown still leaves the process.
    await this.client.quit();
  }
}
