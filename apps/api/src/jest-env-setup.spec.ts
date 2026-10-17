import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

@Controller()
class ProbeController {
  @Get('probe')
  probe() {
    return { ok: true };
  }
}

async function nestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

function boundAddress(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.once('listening', () =>
      resolve((server.address() as AddressInfo).address),
    ),
  );
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe('jest env setup: ephemeral test servers bind IPv4 loopback', () => {
  it("supertest's lazy listen(0) on a Nest server binds 127.0.0.1, not the dual-stack wildcard", async () => {
    const app = await nestApp();
    try {
      const server = app.getHttpServer() as Server;
      const address = boundAddress(server);
      const res = await request(server).get('/probe');
      expect(res.status).toBe(200);
      expect(await address).toBe('127.0.0.1');
    } finally {
      await app.close();
    }
  });

  it('a Nest app.listen(0) binds 127.0.0.1 and supertest still reaches it', async () => {
    const app = await nestApp();
    try {
      await app.listen(0);
      const server = app.getHttpServer() as Server;
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
      const res = await request(server).get('/probe');
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('an explicit host is left untouched', async () => {
    const server = createServer();
    const address = boundAddress(server);
    server.listen(0, '0.0.0.0');
    expect(await address).toBe('0.0.0.0');
    await close(server);
  });

  it('the listen shim is installed once, however many spec files load the setup', () => {
    const listen: unknown = Reflect.get(Server.prototype, 'listen');
    jest.isolateModules(() => {
      jest.requireActual('../test/jest.env-setup');
    });
    expect(Reflect.get(Server.prototype, 'listen')).toBe(listen);
  });
});
