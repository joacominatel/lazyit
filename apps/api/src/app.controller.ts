import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { APP_NAME } from "@lazyit/shared";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
