import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { listWindow, sendPage } from "../../common/pagination";

@ApiTags("customers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("customers")
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  /** Paged. See common/pagination.ts for why the body stays a bare array
   * and the count travels in `X-Total-Count`. */
  @Get()
  async list(
    @Res({ passthrough: true }) res: Response,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(res, await this.customersService.list(window));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.customersService.get(id);
  }

  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string) {
    await this.customersService.remove(id);
  }
}
