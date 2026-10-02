// No real Prisma client: the fakes below stand in for the database.
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import {
  AI_SETTINGS_DEFAULTS,
  PURCHASE_EXTRACTION_MAX_BYTES,
  PurchaseExtractionDraftSchema,
  type AiSettings,
} from '@lazyit/shared';
import { ActorService } from '../../common/actor.service';
import type { Principal } from '../../auth/principal';
import type { PermissionResolverService } from '../../auth/permission-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ResolvedAiProviderConfig } from '../../ai/core/ports/ai-settings.port';
import type {
  StructuredExtractionPort,
  StructuredExtractionRequest,
} from '../../ai/core/ports/structured-extraction.port';
import {
  AiProviderError,
  AiStructuredOutputError,
} from '../../ai/providers/ai-provider.error';
import type { AiRunLimits } from '../../ai/runtime/limits';
import type { ExtractionModelOutput } from './extraction-model';
import {
  PurchaseExtractionService,
  countPdfPages,
} from './purchase-extraction.service';

const PO = 'clpo00000000000000000001';
const ATT = 'clatt0000000000000000001';
const SUPPLIER = 'clsupplier00000000000001';
const MODEL = 'clmodel00000000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SHA = 'ab'.padEnd(64, '0');

const human = {
  kind: 'human',
  user: { id: USER_ID, role: 'MEMBER' },
} as unknown as Principal;
const serviceAccount = {
  kind: 'service',
  serviceAccount: { id: 'clsa0000000000000000001' },
  permissions: new Set(['purchaseOrder:write', 'ai:use']),
} as unknown as Principal;

const CONFIG: ResolvedAiProviderConfig = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  baseUrl: null,
  apiKey: 'sk-test',
  allowPrivateNetwork: false,
  effort: null,
  providerOptions: null,
};

const none = { value: null, text: null, page: null };
const lit = (text: string | null, page: number | null = 1) => ({ text, page });
const tx = (value: string, page = 1) => ({ value, text: value, page });

/** What the fake model transcribes: an Argentine invoice. */
function invoice(
  over: Partial<ExtractionModelOutput> = {},
): ExtractionModelOutput {
  return {
    header: {
      supplierName: tx('COMPUMUNDO S.A.'),
      supplierTaxId: tx('30-71234567-9'),
      reference: tx('OC-2026-0042'),
      currency: tx('ARS'),
      orderDate: { value: '2026-02-28', text: '28/02/2026', page: 1 },
      invoiceNumbers: tx('A 0003-00012345'),
      invoiceDate: { value: '2026-03-10', text: '10/03/2026', page: 1 },
    },
    lines: [
      {
        kind: 'ASSET',
        description: tx('NB LEN E14 G5'),
        manufacturer: tx('Lenovo'),
        model: tx('ThinkPad E14 Gen 5'),
        quantity: lit('4'),
        unitPrice: lit('1.412.500,00'),
        lineTotal: lit('5.650.000,00'),
        warrantyMonths: { value: 12, text: '12 meses', page: 1 },
      },
      {
        kind: 'OTHER',
        description: tx('Flete'),
        manufacturer: none,
        model: none,
        quantity: lit('1'),
        unitPrice: lit(null, null),
        lineTotal: lit(null, null),
        warrantyMonths: none,
      },
    ],
    totals: {
      net: lit('5.650.000,00'),
      tax: lit('1.186.500,00'),
      gross: lit('6.836.500,00'),
    },
    moreLines: null,
    ...over,
  };
}

function settingsWith(over: Partial<AiSettings> = {}): AiSettings {
  return {
    ...AI_SETTINGS_DEFAULTS,
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5',
    baseUrl: null,
    apiKeySet: true,
    keyConfigured: true,
    effort: null,
    providerOptions: null,
    instructions: null,
    disclosureAcknowledgedAt: null,
    verifiedAt: null,
    updatedAt: null,
    documentExtractionEnabled: true,
    ...over,
  } as AiSettings;
}

function makePrisma() {
  const prisma = {
    purchaseOrder: {
      findFirst: jest.fn().mockResolvedValue({ id: PO }),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    purchaseOrderLine: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    attachment: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ mimeType: 'application/pdf', sha256: SHA }),
      update: jest.fn(),
    },
    supplier: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    assetModel: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    asset: { update: jest.fn(), updateMany: jest.fn() },
    application: { update: jest.fn() },
    aiUsage: { create: jest.fn().mockResolvedValue({}) },
    purchaseOrderEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  return prisma;
}

type FakePrisma = ReturnType<typeof makePrisma>;

function setup(
  opts: {
    config?: ResolvedAiProviderConfig | null;
    settings?: Partial<AiSettings>;
    output?: ExtractionModelOutput;
    budgetExceeded?: boolean;
    held?: string[];
  } = {},
) {
  const prisma = makePrisma();
  const port = {
    extractStructured: jest.fn(
      (request: StructuredExtractionRequest<unknown>) => {
        void request;
        return Promise.resolve({
          output: opts.output ?? invoice(),
          usage: { inputTokens: 1200, outputTokens: 300 },
          finishReason: 'stop',
        });
      },
    ),
  };
  const reader = {
    getSettings: jest.fn().mockResolvedValue(settingsWith(opts.settings)),
    resolveProviderConfig: jest
      .fn()
      .mockResolvedValue(opts.config === undefined ? CONFIG : opts.config),
  };
  const limits = {
    budgetExceeded: jest.fn().mockResolvedValue(opts.budgetExceeded ?? false),
  };
  const permissions = {
    resolve: jest
      .fn()
      .mockResolvedValue(
        new Set(opts.held ?? ['purchaseOrder:write', 'ai:use']),
      ),
  };
  const service = new PurchaseExtractionService(
    prisma as unknown as PrismaService,
    new ActorService(),
    permissions as unknown as PermissionResolverService,
    limits as unknown as AiRunLimits,
    reader,
    port as unknown as StructuredExtractionPort,
  );
  return { service, prisma, port, reader, limits };
}

/** Every write call on the fake, except the two the extraction is allowed: usage and the event. */
function forbiddenWrites(prisma: FakePrisma): unknown[] {
  return [
    prisma.purchaseOrder.create,
    prisma.purchaseOrder.update,
    prisma.purchaseOrder.updateMany,
    prisma.purchaseOrderLine.create,
    prisma.purchaseOrderLine.update,
    prisma.purchaseOrderLine.updateMany,
    prisma.attachment.update,
    prisma.supplier.create,
    prisma.supplier.update,
    prisma.assetModel.create,
    prisma.assetModel.update,
    prisma.asset.update,
    prisma.asset.updateMany,
    prisma.application.update,
  ].flatMap((fn): unknown[] => fn.mock.calls as unknown[]);
}

/** The `data` of the first activity-log row written. */
function eventData(prisma: FakePrisma): Record<string, unknown> {
  return (
    prisma.purchaseOrderEvent.create.mock.calls as [
      { data: Record<string, unknown> },
    ][]
  )[0][0].data;
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    return {
      status: http.getStatus(),
      body: http.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error('expected a refusal');
}

describe('PurchaseExtractionService (ADR-0099 §11, #1477)', () => {
  let dir: string;
  const pdf = Buffer.from(
    '%PDF-1.7\n1 0 obj << /Type /Pages /Count 1 >>\n2 0 obj << /Type /Page >>\n%%EOF',
  );

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    dir = await mkdtemp(join(tmpdir(), 'lazyit-extract-'));
    process.env.ATTACHMENTS_DIR = dir;
    await mkdir(join(dir, SHA.slice(0, 2)), { recursive: true });
    await writeFile(join(dir, SHA.slice(0, 2), SHA), pdf);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    delete process.env.ATTACHMENTS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  describe('availability — a typed reason, nothing sent', () => {
    it.each([
      [
        'the assistant is off (no usable configuration)',
        { config: null },
        'AI_DISABLED',
      ],
      [
        'a key-bearing provider without its key',
        { config: { ...CONFIG, apiKey: null } },
        'AI_DISABLED',
      ],
      [
        'the Document extraction switch is off (the default)',
        { settings: { documentExtractionEnabled: false } },
        'EXTRACTION_DISABLED',
      ],
      [
        'the provider reads no document (OpenAI-compatible)',
        {
          config: {
            ...CONFIG,
            provider: 'openai-compatible' as const,
            apiKey: null,
            baseUrl: 'https://llm.example.com/v1',
          },
        },
        'PROVIDER_UNSUPPORTED',
      ],
    ])('%s → 409 %s', async (_label, opts, code) => {
      const { service, port, prisma } = setup(opts);
      const refused = await refusalOf(service.extract(PO, ATT, human));
      expect(refused).toMatchObject({ status: 409, body: { code } });
      expect(port.extractStructured).not.toHaveBeenCalled();
      expect(prisma.purchaseOrderEvent.create).not.toHaveBeenCalled();

      const status = await service.status(human);
      expect(status).toMatchObject({
        available: false,
        reason: code,
        mediaTypes: [],
      });
    });

    it('the status reports the readable types to a person who may extract, NOT_PERMITTED otherwise', async () => {
      expect(await setup().service.status(human)).toMatchObject({
        available: true,
        reason: null,
        mediaTypes: expect.arrayContaining([
          'application/pdf',
          'image/png',
        ]) as unknown,
        maxBytes: PURCHASE_EXTRACTION_MAX_BYTES,
      });
      expect(await setup().service.status(serviceAccount)).toMatchObject({
        available: false,
        reason: 'NOT_PERMITTED',
      });
      expect(
        await setup({ held: ['purchaseOrder:write'] }).service.status(human),
      ).toMatchObject({ available: false, reason: 'NOT_PERMITTED' });
    });

    it('a service account is refused (extraction is human-only), even holding both permissions', async () => {
      const { service, port } = setup();
      await expect(
        service.extract(PO, ATT, serviceAccount),
      ).rejects.toMatchObject({
        status: 403,
      });
      expect(port.extractStructured).not.toHaveBeenCalled();
    });
  });

  describe('the document', () => {
    it('a type the provider does not read is a 422, never sent', async () => {
      const { service, prisma, port } = setup();
      prisma.attachment.findFirst.mockResolvedValue({
        mimeType: 'text/csv',
        sha256: SHA,
      });
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 422,
        body: { code: 'UNSUPPORTED_MEDIA_TYPE' },
      });
      expect(port.extractStructured).not.toHaveBeenCalled();
    });

    it('only an attachment of THIS live purchase: 404 otherwise', async () => {
      const { service, prisma } = setup();
      prisma.attachment.findFirst.mockResolvedValue(null);
      await expect(service.extract(PO, ATT, human)).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.attachment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ATT, entityType: 'PURCHASE_ORDER', entityId: PO },
        }),
      );
      prisma.purchaseOrder.findFirst.mockResolvedValue(null);
      await expect(service.extract(PO, ATT, human)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('a document over the size cap or the page cap is a 422', async () => {
      const big = setup();
      await writeFile(
        join(dir, SHA.slice(0, 2), SHA),
        Buffer.alloc(PURCHASE_EXTRACTION_MAX_BYTES + 1),
      );
      expect(
        await refusalOf(big.service.extract(PO, ATT, human)),
      ).toMatchObject({
        status: 422,
        body: { code: 'DOCUMENT_TOO_LARGE' },
      });

      const long = setup();
      await writeFile(
        join(dir, SHA.slice(0, 2), SHA),
        Buffer.from(`%PDF-1.7\n${'<< /Type /Page >>\n'.repeat(21)}`),
      );
      expect(
        await refusalOf(long.service.extract(PO, ATT, human)),
      ).toMatchObject({
        status: 422,
        body: { code: 'TOO_MANY_PAGES' },
      });
      expect(long.port.extractStructured).not.toHaveBeenCalled();
    });

    it('counts page objects, not the page tree', () => {
      expect(countPdfPages(pdf)).toBe(1);
    });
  });

  describe('per provider', () => {
    it('Gemini reads no GIF: a 422 before anything is sent; the status lists what it reads', async () => {
      const gemini = {
        ...CONFIG,
        provider: 'google' as const,
        model: 'gemini-3.8-flash',
      };
      const { service, prisma, port } = setup({ config: gemini });
      prisma.attachment.findFirst.mockResolvedValue({
        mimeType: 'image/gif',
        sha256: SHA,
      });
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 422,
        body: { code: 'UNSUPPORTED_MEDIA_TYPE' },
      });
      expect(port.extractStructured).not.toHaveBeenCalled();
      const status = await service.status(human);
      expect(status.mediaTypes).not.toContain('image/gif');
      expect(status.mediaTypes).toContain('application/pdf');
    });

    it('Anthropic images are capped at about 7.5 MB raw (10 MB base64) before anything is sent', async () => {
      await writeFile(
        join(dir, SHA.slice(0, 2), SHA),
        Buffer.alloc(8 * 1024 * 1024),
      );
      const anthropic = setup();
      anthropic.prisma.attachment.findFirst.mockResolvedValue({
        mimeType: 'image/png',
        sha256: SHA,
      });
      expect(
        await refusalOf(anthropic.service.extract(PO, ATT, human)),
      ).toMatchObject({
        status: 422,
        body: { code: 'DOCUMENT_TOO_LARGE', maxBytes: 7_864_320 },
      });
      expect(anthropic.port.extractStructured).not.toHaveBeenCalled();
      expect(
        (await anthropic.service.status(human)).maxBytesByMediaType,
      ).toMatchObject({
        'image/png': 7_864_320,
        'application/pdf': PURCHASE_EXTRACTION_MAX_BYTES,
      });

      // The same image goes to OpenAI, whose limit is not lower than the extraction cap.
      const openai = setup({
        config: { ...CONFIG, provider: 'openai', model: 'gpt-6-sol' },
      });
      openai.prisma.attachment.findFirst.mockResolvedValue({
        mimeType: 'image/png',
        sha256: SHA,
      });
      await openai.service.extract(PO, ATT, human);
      expect(openai.port.extractStructured).toHaveBeenCalledTimes(1);
    });
  });

  describe('one at a time, a few a minute — per person', () => {
    it('a second extraction while one is running is a 429; the next one after it goes through', async () => {
      const { service, port } = setup();
      let release: () => void = () => undefined;
      port.extractStructured.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                output: invoice(),
                usage: { inputTokens: 1, outputTokens: 1 },
                finishReason: 'stop',
              });
          }),
      );
      const first = service.extract(PO, ATT, human);
      // Let the first one reach the model call.
      for (
        let i = 0;
        i < 100 && port.extractStructured.mock.calls.length === 0;
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(port.extractStructured).toHaveBeenCalledTimes(1);
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 429,
        body: { code: 'EXTRACTION_IN_PROGRESS' },
      });
      release();
      await first;
      await service.extract(PO, ATT, human);
      expect(port.extractStructured).toHaveBeenCalledTimes(2);
    });

    it('past five a minute it is a 429 with a retry hint, nothing sent', async () => {
      const { service, port } = setup();
      for (let i = 0; i < 5; i += 1) await service.extract(PO, ATT, human);
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 429,
        body: {
          code: 'RATE_LIMITED',
          retryAfterSec: expect.any(Number) as unknown,
        },
      });
      expect(port.extractStructured).toHaveBeenCalledTimes(5);
    });

    it('a refused document costs no attempt', async () => {
      const { service, prisma, port } = setup();
      prisma.attachment.findFirst.mockResolvedValue({
        mimeType: 'text/csv',
        sha256: SHA,
      });
      for (let i = 0; i < 6; i += 1) {
        await refusalOf(service.extract(PO, ATT, human));
      }
      prisma.attachment.findFirst.mockResolvedValue({
        mimeType: 'application/pdf',
        sha256: SHA,
      });
      await service.extract(PO, ATT, human);
      expect(port.extractStructured).toHaveBeenCalledTimes(1);
    });
  });

  it('the daily token budget is enforced before anything is sent (429)', async () => {
    const { service, port, limits } = setup({
      settings: { dailyTokenLimitPerPrincipal: 1000 },
      budgetExceeded: true,
    });
    expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
      status: 429,
      body: { code: 'BUDGET_EXCEEDED' },
    });
    expect(limits.budgetExceeded).toHaveBeenCalledWith(
      { userId: USER_ID },
      1000,
    );
    expect(port.extractStructured).not.toHaveBeenCalled();
  });

  describe('a draft, and nothing saved', () => {
    it('sends the document with no tools, returns a draft and writes only the usage and the event', async () => {
      const { service, prisma, port } = setup();
      const draft = await service.extract(PO, ATT, human);

      expect(PurchaseExtractionDraftSchema.safeParse(draft).success).toBe(true);
      // The call: the file inline, the fixed instructions, a schema, NO tools of any kind.
      const request = port.extractStructured.mock.calls[0][0];
      expect(request).not.toHaveProperty('tools');
      expect(request.model).toEqual({
        provider: 'anthropic',
        modelId: 'claude-opus-5',
      });
      expect(request.file.mediaType).toBe('application/pdf');
      expect(Buffer.from(request.file.data).equals(pdf)).toBe(true);
      expect(request.instructions).toMatch(/untrusted data/);
      expect(request.abortSignal).toBeDefined();

      // Nothing is created or changed on the purchase, its lines, suppliers, models, assets or applications.
      expect(forbiddenWrites(prisma)).toEqual([]);
      expect(prisma.aiUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          runId: draft.extractionId,
          userId: USER_ID,
          inputTokens: 1200,
          outputTokens: 300,
        }) as unknown,
      });
    });

    it('records EXTRACTION_RUN with metadata only — no value read from the document', async () => {
      const { service, prisma } = setup();
      const draft = await service.extract(PO, ATT, human);
      const event = eventData(prisma);
      expect(event).toMatchObject({
        purchaseOrderId: PO,
        eventType: 'EXTRACTION_RUN',
        performedById: USER_ID,
        payload: {
          extractionId: draft.extractionId,
          attachmentId: ATT,
          outcome: 'SUCCEEDED',
          errorCode: null,
          provider: 'anthropic',
          model: 'claude-opus-5',
          lineCount: 2,
        },
      });
      const serialized = JSON.stringify(event);
      for (const content of [
        'COMPUMUNDO',
        '30-71234567',
        'OC-2026',
        '1.412.500',
        'Flete',
      ]) {
        expect(serialized).not.toContain(content);
      }
    });

    it('reads es amounts into minor units and keeps every blank blank', async () => {
      const draft = await setup().service.extract(PO, ATT, human);
      const [laptop, freight] = draft.lines;
      expect(laptop.quantity.value).toBe(4);
      expect(laptop.unitPrice).toEqual({
        value: 141_250_000,
        evidence: { text: '1.412.500,00', page: 1 },
      });
      expect(laptop.warrantyMonths.value).toBe(12);
      expect(draft.header.invoiceDate.value).toBe('2026-03-10T00:00:00.000Z');
      // `28/02/2026` settles the document's day/month order, so `10/03/2026` reads as 10 March.
      expect(draft.header.orderDate.value).toBe('2026-02-28T00:00:00.000Z');
      expect(draft.header.supplierTaxId.value).toBe('30-71234567-9');
      expect(freight.unitPrice).toEqual({ value: null, evidence: null });
      expect(freight.manufacturerText).toEqual({
        value: null,
        evidence: null,
      });
      expect(draft.totals).toMatchObject({
        linesTotal: 565_000_000,
        incompleteLines: 1,
        net: { value: 565_000_000 },
      });
      // The lines add up to the printed net: no mismatch.
      expect(draft.warnings.map((w) => w.code)).not.toContain('TOTAL_MISMATCH');
    });

    it('reads en amounts the same way', async () => {
      const en = invoice();
      en.lines[0].unitPrice = lit('USD 1,412,500.00');
      en.lines[0].lineTotal = lit('5,650,000.00');
      en.totals = {
        net: lit('5,650,000.00'),
        tax: lit(null, null),
        gross: lit(null, null),
      };
      const draft = await setup({ output: en }).service.extract(PO, ATT, human);
      expect(draft.lines[0].unitPrice.value).toBe(141_250_000);
      expect(draft.totals.net.value).toBe(565_000_000);
    });

    it('flags the lines that do not add up to the document total, and never corrects them', async () => {
      const off = invoice();
      off.lines = [off.lines[0]];
      off.totals = {
        net: lit('5.675.000,00'),
        tax: lit(null, null),
        gross: lit('6.866.750,00'),
      };
      const draft = await setup({ output: off }).service.extract(
        PO,
        ATT,
        human,
      );
      expect(draft.warnings).toContainEqual({
        code: 'TOTAL_MISMATCH',
        path: 'totals',
        detail: {
          linesTotal: 565_000_000,
          net: 567_500_000,
          gross: 686_675_000,
        },
      });
      expect(draft.lines[0].unitPrice.value).toBe(141_250_000);
    });

    it('compares no total while a line is incomplete — the gap is expected', async () => {
      const off = invoice();
      off.totals = {
        net: lit('5.675.000,00'),
        tax: lit(null, null),
        gross: lit(null, null),
      };
      const draft = await setup({ output: off }).service.extract(
        PO,
        ATT,
        human,
      );
      expect(draft.totals.incompleteLines).toBe(1);
      expect(draft.warnings.map((w) => w.code)).not.toContain('TOTAL_MISMATCH');
    });

    it('a date that reads two ways, with nothing to settle the order, is blank and flagged', async () => {
      const vague = invoice();
      vague.header.orderDate = none;
      const draft = await setup({ output: vague }).service.extract(
        PO,
        ATT,
        human,
      );
      expect(draft.header.invoiceDate).toEqual({
        value: null,
        evidence: { text: '10/03/2026', page: 1 },
      });
      expect(draft.warnings).toContainEqual({
        code: 'DATE_AMBIGUOUS',
        path: 'header.invoiceDate',
      });
    });

    it('asks for at most the lines that fit the output cap, and flags a cut document', async () => {
      const long = invoice({ moreLines: true });
      const { service, port } = setup({ output: long });
      const draft = await service.extract(PO, ATT, human);
      expect(port.extractStructured.mock.calls[0][0].prompt).toMatch(
        /at most 80 item lines/,
      );
      expect(draft.warnings).toContainEqual({
        code: 'LINES_TRUNCATED',
        path: 'lines',
        detail: { lines: 2, kept: 2 },
      });

      // A lower output cap asks for fewer lines, and keeps no more than that.
      const many = invoice();
      many.lines = Array.from({ length: 20 }, () => invoice().lines[0]);
      const low = setup({ output: many, settings: { maxOutputTokens: 4_000 } });
      const cut = await low.service.extract(PO, ATT, human);
      expect(low.port.extractStructured.mock.calls[0][0]).toMatchObject({
        maxOutputTokens: 4_000,
        prompt: expect.stringMatching(/at most 16 item lines/) as unknown,
      });
      expect(cut.lines).toHaveLength(16);
      expect(cut.warnings).toContainEqual({
        code: 'LINES_TRUNCATED',
        path: 'lines',
        detail: { lines: 20, kept: 16 },
      });
    });

    it('an amount that reads two ways is left blank and flagged when the document settles nothing', async () => {
      const vague = invoice();
      vague.lines = [
        {
          ...vague.lines[0],
          unitPrice: lit('1.150'),
          lineTotal: lit(null, null),
        },
      ];
      vague.totals = {
        net: lit(null, null),
        tax: lit(null, null),
        gross: lit(null, null),
      };
      const draft = await setup({ output: vague }).service.extract(
        PO,
        ATT,
        human,
      );
      expect(draft.lines[0].unitPrice).toEqual({
        value: null,
        evidence: { text: '1.150', page: 1 },
      });
      expect(draft.warnings).toContainEqual({
        code: 'AMOUNT_AMBIGUOUS',
        path: 'lines.0.unitPrice',
      });
    });
  });

  describe('suggestions, never created', () => {
    it('matches the supplier by tax ID first, whatever the punctuation', async () => {
      const { service, prisma } = setup();
      prisma.supplier.findMany.mockResolvedValue([
        { id: SUPPLIER, name: 'Compumundo', taxId: '30712345679' },
        { id: 'clsupplier00000000000002', name: 'COMPUMUNDO SA', taxId: null },
      ]);
      const draft = await service.extract(PO, ATT, human);
      expect(draft.matches.supplier).toEqual({
        id: SUPPLIER,
        name: 'Compumundo',
        by: 'TAX_ID',
      });
      expect(prisma.supplier.create).not.toHaveBeenCalled();
    });

    it('falls back to a unique normalized name, and suggests nothing when two suppliers share it', async () => {
      const one = setup();
      one.prisma.supplier.findMany.mockResolvedValue([
        { id: SUPPLIER, name: 'Compumundo S.A.', taxId: null },
      ]);
      expect(
        (await one.service.extract(PO, ATT, human)).matches.supplier,
      ).toMatchObject({
        id: SUPPLIER,
        by: 'NAME',
      });

      const two = setup();
      two.prisma.supplier.findMany.mockResolvedValue([
        { id: SUPPLIER, name: 'Compumundo S.A.', taxId: null },
        { id: 'clsupplier00000000000002', name: 'compumundo', taxId: null },
      ]);
      expect(
        (await two.service.extract(PO, ATT, human)).matches.supplier,
      ).toBeNull();
    });

    it("matches a line's model by brand and model text; the freight line gets none", async () => {
      const { service, prisma } = setup();
      prisma.assetModel.findMany.mockResolvedValue([
        { id: MODEL, name: 'ThinkPad E14 GEN5', manufacturer: 'LENOVO' },
        {
          id: 'clmodel00000000000000002',
          name: 'ThinkPad E16 Gen 5',
          manufacturer: 'Lenovo',
        },
      ]);
      const draft = await service.extract(PO, ATT, human);
      expect(draft.matches.lineModels).toEqual([
        {
          id: MODEL,
          name: 'ThinkPad E14 GEN5',
          manufacturer: 'LENOVO',
          by: 'NAME',
        },
        null,
      ]);
    });

    it('prefers the model an earlier line with the same description was mapped to', async () => {
      const { service, prisma } = setup();
      prisma.purchaseOrderLine.findMany.mockResolvedValue([
        {
          description: 'nb len e14 g5',
          assetModel: { id: MODEL, name: 'E14 G5', manufacturer: 'Lenovo' },
        },
      ]);
      const draft = await service.extract(PO, ATT, human);
      expect(draft.matches.lineModels[0]).toEqual({
        id: MODEL,
        name: 'E14 G5',
        manufacturer: 'Lenovo',
        by: 'LINE_MEMORY',
      });
    });
  });

  describe('failures — nothing filled, the run still recorded', () => {
    it('an answer that does not fit the schema is a 502, its tokens counted', async () => {
      const { service, prisma, port } = setup();
      port.extractStructured.mockRejectedValue(
        new AiStructuredOutputError({ inputTokens: 900, outputTokens: 10 }),
      );
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 502,
        body: { code: 'EXTRACTION_UNREADABLE' },
      });
      expect(prisma.aiUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          inputTokens: 900,
          outputTokens: 10,
        }) as unknown,
      });
      expect(eventData(prisma).payload).toMatchObject({
        outcome: 'FAILED',
        errorCode: 'EXTRACTION_UNREADABLE',
      });
      expect(forbiddenWrites(prisma)).toEqual([]);
    });

    it('a provider failure keeps its code (502), with no provider detail', async () => {
      const { service, port, prisma } = setup();
      port.extractStructured.mockRejectedValue(
        new AiProviderError('PROVIDER_RATE_LIMIT', { retryAfterSec: 30 }),
      );
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 502,
        body: { code: 'PROVIDER_RATE_LIMIT', retryAfterSec: 30 },
      });
      expect(prisma.aiUsage.create).not.toHaveBeenCalled();
    });

    it('records no run when the document never left: the configuration moved before the call', async () => {
      for (const err of [
        new AiProviderError('CONVERSATION_READ_ONLY'),
        new AiProviderError('AI_DISABLED'),
        new AiProviderError('PROVIDER_AUTH'),
      ]) {
        const { service, port, prisma } = setup();
        port.extractStructured.mockRejectedValue(err);
        expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
          status: 409,
          body: { code: 'AI_DISABLED' },
        });
        expect(prisma.purchaseOrderEvent.create).not.toHaveBeenCalled();
        expect(prisma.aiUsage.create).not.toHaveBeenCalled();
      }
    });

    it('an answered refusal (a 401) did reach the provider: the run is recorded', async () => {
      const { service, port, prisma } = setup();
      port.extractStructured.mockRejectedValue(
        new AiProviderError('PROVIDER_AUTH', { status: 401 }),
      );
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 502,
        body: { code: 'PROVIDER_AUTH' },
      });
      expect(eventData(prisma).payload).toMatchObject({
        outcome: 'FAILED',
        errorCode: 'PROVIDER_AUTH',
      });
    });

    it('speaks of the document, not a conversation, when it is too long for the model', async () => {
      const { service, port } = setup();
      port.extractStructured.mockRejectedValue(
        new AiProviderError('CONTEXT_LIMIT', { status: 400 }),
      );
      const refused = await refusalOf(service.extract(PO, ATT, human));
      expect(refused.body).toMatchObject({ code: 'CONTEXT_LIMIT' });
      expect(String(refused.body.message)).toMatch(/document is too long/);
    });

    it('a call past the timeout is a 504', async () => {
      const { service, port } = setup();
      port.extractStructured.mockImplementation(
        (request: StructuredExtractionRequest<unknown>) => {
          // The deadline fired: the signal is aborted when the provider layer gives up.
          Object.defineProperty(request.abortSignal, 'aborted', {
            value: true,
          });
          return Promise.reject(new AiProviderError('CANCELLED'));
        },
      );
      expect(await refusalOf(service.extract(PO, ATT, human))).toMatchObject({
        status: 504,
        body: { code: 'EXTRACTION_TIMEOUT' },
      });
    });
  });
});
