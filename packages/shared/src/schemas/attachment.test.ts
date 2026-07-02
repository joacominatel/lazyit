import { describe, expect, it } from "bun:test";
import {
  ARTICLE_IMAGE_MIME_TYPES,
  ASSET_ATTACHMENT_MIME_TYPES,
  ATTACHMENT_INLINE_MIME_TYPES,
  AttachmentSchema,
  attachmentRefId,
} from "./attachment";

const VALID = {
  id: "clatt0000000000000000000",
  entityType: "ASSET",
  entityId: "classet000000000000000000",
  sha256: "a".repeat(64),
  byteSize: 1024,
  mimeType: "application/pdf",
  originalName: "warranty.pdf",
  uploadedById: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

describe("AttachmentSchema (ADR-0082)", () => {
  it("accepts a valid row", () => {
    expect(AttachmentSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts a null uploadedById (uploader hard-deleted, SetNull)", () => {
    expect(
      AttachmentSchema.safeParse({ ...VALID, uploadedById: null }).success,
    ).toBe(true);
  });

  it("rejects a non-hex sha256", () => {
    expect(
      AttachmentSchema.safeParse({ ...VALID, sha256: "Z".repeat(64) }).success,
    ).toBe(false);
  });

  it("rejects an unknown entityType", () => {
    expect(
      AttachmentSchema.safeParse({ ...VALID, entityType: "CONSUMABLE" })
        .success,
    ).toBe(false);
  });
});

describe("allowlists (ADR-0082 §3/§4)", () => {
  it("never allowlists SVG or HTML (red line)", () => {
    const all = [
      ...ASSET_ATTACHMENT_MIME_TYPES,
      ...ARTICLE_IMAGE_MIME_TYPES,
    ] as readonly string[];
    expect(all).not.toContain("image/svg+xml");
    expect(all).not.toContain("text/html");
  });

  it("inlines only the raster image types (docs, incl. PDF, are downloads)", () => {
    const inline = ATTACHMENT_INLINE_MIME_TYPES as readonly string[];
    expect(inline).not.toContain("application/pdf");
    expect(inline).toContain("image/png");
  });
});

describe("attachmentRefId (ADR-0082 §5)", () => {
  it("parses an attachment ref", () => {
    expect(attachmentRefId("attachment:clatt0000000000000000000")).toBe(
      "clatt0000000000000000000",
    );
  });

  it("rejects external / data / javascript URLs (never an attachment ref)", () => {
    expect(attachmentRefId("https://evil.example/x.png")).toBeNull();
    expect(attachmentRefId("data:image/png;base64,AAAA")).toBeNull();
    // eslint-disable-next-line no-script-url
    expect(attachmentRefId("javascript:alert(1)")).toBeNull();
  });

  it("rejects a ref whose id carries path characters", () => {
    expect(attachmentRefId("attachment:../../etc/passwd")).toBeNull();
    expect(attachmentRefId("attachment:")).toBeNull();
  });
});
