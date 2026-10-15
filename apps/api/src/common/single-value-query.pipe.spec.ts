import { Controller, Get, type INestApplication, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CommonModule } from './common.module';
import { parseBooleanQuery } from './parse-boolean-query';

@Controller('probe')
class ProbeController {
  @Get('scalar')
  scalar(@Query('q') q?: string, @Query('activeOnly') activeOnly?: string) {
    return { q: q?.trim(), activeOnly: parseBooleanQuery(activeOnly, true) };
  }

  @Get('multi')
  multi(@Query('status') status?: string | string[]) {
    return { status };
  }

  @Get('whole')
  whole(@Query() query: Record<string, unknown>) {
    return query;
  }
}

describe('SingleValueQueryPipe — registered globally by CommonModule (AUD-066)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a repeated scalar param with a 400 naming it, not a 500', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/scalar?q=a&q=b')
      .expect(400);
    expect(res.body).toMatchObject({
      message: 'Invalid q: expected a single value',
    });

    await request(app.getHttpServer())
      .get('/probe/scalar?activeOnly=a&activeOnly=b')
      .expect(400);
  });

  it('leaves a single value untouched', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/scalar?q=%20laptop%20&activeOnly=false')
      .expect(200);
    expect(res.body).toEqual({ q: 'laptop', activeOnly: false });
  });

  it('still hands a multi-value filter its repeated form as an array', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/multi?status=DRAFT&status=PUBLISHED')
      .expect(200);
    expect(res.body).toEqual({ status: ['DRAFT', 'PUBLISHED'] });
  });

  it('does not touch a whole-object @Query()', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/whole?ids=a&ids=b')
      .expect(200);
    expect(res.body).toEqual({ ids: ['a', 'b'] });
  });
});
