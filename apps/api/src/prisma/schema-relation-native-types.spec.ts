import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards a schema invariant Prisma itself does not check: the two sides of a relation must
 * agree on their PostgreSQL native type.
 *
 * `User.id` is `String @id @default(uuid()) @db.Uuid`, so every FK scalar pointing at it must
 * also carry `@db.Uuid`. Omit it on one column and Prisma reads the column as `TEXT` while the
 * migration created it as `UUID`. Nothing complains at write time — the drift only surfaces
 * when someone runs `prisma migrate dev`, which then generates a migration that alters the
 * column to `TEXT` and fails re-adding the foreign key, because PostgreSQL has no equality
 * operator between `text` and `uuid`. That was issue #1179, on
 * `InfraAutoConfirmRule.createdById`.
 *
 * The check is symmetric and target-agnostic: it compares the `@db.*` native type of each FK
 * scalar against the field it references, whichever models those are, so a future relation to
 * any uuid-keyed model is covered without touching this file.
 */

const SCHEMA_PATH = join(__dirname, '..', '..', 'prisma', 'schema.prisma');

interface SchemaField {
  readonly name: string;
  readonly line: number;
  readonly nativeType: string | null;
}

interface RelationField {
  readonly model: string;
  readonly line: number;
  readonly targetModel: string;
  /** Local scalar field names, positionally paired with `references`. */
  readonly fields: readonly string[];
  readonly references: readonly string[];
}

interface ParsedSchema {
  readonly models: ReadonlyMap<string, ReadonlyMap<string, SchemaField>>;
  readonly relations: readonly RelationField[];
  /** `@relation`s carrying `fields:` that the line parser could not read — never silently ignored. */
  readonly unparsed: readonly string[];
}

/** Extracts the `@db.X` native-type attribute from a field line, e.g. `@db.Uuid` -> `Uuid`. */
function nativeTypeOf(line: string): string | null {
  return /@db\.(\w+)/.exec(line)?.[1] ?? null;
}

function parseSchema(source: string): ParsedSchema {
  const models = new Map<string, Map<string, SchemaField>>();
  const relations: RelationField[] = [];
  const unparsed: string[] = [];

  let currentModel: string | null = null;
  let currentFields: Map<string, SchemaField> | null = null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNumber = i + 1;

    const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelStart) {
      currentModel = modelStart[1];
      currentFields = new Map();
      models.set(currentModel, currentFields);
      continue;
    }
    if (/^\}/.test(line)) {
      currentModel = null;
      currentFields = null;
      continue;
    }
    if (!currentModel || !currentFields) continue;

    // `  name  Type[]?  @attrs...` — block attributes (`@@index`) and comments fall through.
    const field = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!field) continue;
    const name = field[1];
    const fieldType = field[2];
    const isList = field[3] !== undefined;
    const attrs = field[5] ?? '';

    currentFields.set(name, {
      name,
      line: lineNumber,
      nativeType: nativeTypeOf(line),
    });

    if (isList || !attrs.includes('fields:')) continue;

    const relationArgs = /@relation\(([^)]*)\)/.exec(attrs)?.[1];
    const fieldList = relationArgs
      ? /fields:\s*\[([^\]]*)\]/.exec(relationArgs)?.[1]
      : undefined;
    const referenceList = relationArgs
      ? /references:\s*\[([^\]]*)\]/.exec(relationArgs)?.[1]
      : undefined;

    if (fieldList === undefined || referenceList === undefined) {
      unparsed.push(`${currentModel}.${name} (schema.prisma:${lineNumber})`);
      continue;
    }

    relations.push({
      model: currentModel,
      line: lineNumber,
      targetModel: fieldType,
      fields: fieldList.split(',').map((s) => s.trim()),
      references: referenceList.split(',').map((s) => s.trim()),
    });
  }

  return { models, relations, unparsed };
}

describe('prisma/schema.prisma relation native types', () => {
  const parsed = parseSchema(readFileSync(SCHEMA_PATH, 'utf8'));

  // The parser is the test. If it silently reads nothing, every assertion below passes
  // vacuously — so pin the facts that prove it actually understood the schema.
  describe('parser sanity (guards against a vacuous pass)', () => {
    it('reads User.id as a @db.Uuid field', () => {
      expect(parsed.models.get('User')?.get('id')?.nativeType).toBe('Uuid');
    });

    it('reads a meaningful number of relations with foreign-key scalars', () => {
      expect(parsed.relations.length).toBeGreaterThan(100);
    });

    it('leaves no @relation with fields: unparsed', () => {
      expect(parsed.unparsed).toEqual([]);
    });

    it('resolves every relation target model and referenced field', () => {
      const unresolved = parsed.relations.flatMap((relation) =>
        relation.references
          .filter(
            (reference) =>
              !parsed.models.get(relation.targetModel)?.has(reference),
          )
          .map(
            (reference) =>
              `${relation.model}.${relation.fields.join()} -> ${relation.targetModel}.${reference} (schema.prisma:${relation.line})`,
          ),
      );
      expect(unresolved).toEqual([]);
    });
  });

  it('every foreign-key scalar carries the same @db native type as the field it references', () => {
    const mismatches: string[] = [];

    for (const relation of parsed.relations) {
      const targetFields = parsed.models.get(relation.targetModel);
      if (!targetFields) continue;

      for (let i = 0; i < relation.fields.length; i++) {
        const localName = relation.fields[i];
        const referencedName = relation.references[i];
        if (referencedName === undefined) continue;

        const local = parsed.models.get(relation.model)?.get(localName);
        const referenced = targetFields.get(referencedName);
        if (!local || !referenced) continue;

        if (local.nativeType !== referenced.nativeType) {
          mismatches.push(
            `${relation.model}.${localName} is ${local.nativeType ? `@db.${local.nativeType}` : 'un-annotated'} ` +
              `(schema.prisma:${local.line}) but references ${relation.targetModel}.${referencedName} which is ` +
              `${referenced.nativeType ? `@db.${referenced.nativeType}` : 'un-annotated'} (schema.prisma:${referenced.line})`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
