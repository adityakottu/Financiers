import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  decisionSchema,
  recoveryActionSchema,
  recoveryCloseSchema,
  recoveryOpenSchema,
  recoveryOwnerSchema,
  recoverySettingsSchema,
  recoveryStageSchema,
  rejectSchema,
  releaseSchema,
  repossessSchema,
  saleRequestSchema,
  stageDefinitionSchema,
  writeOffRequestSchema,
} from '@fin/contracts';
import { z } from 'zod';
import { Ctx, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { parse } from '../common/errors';
import { RecoveryService } from './recovery.service';

const listQuery = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  stage: z.string().max(40).optional(),
  branchId: z.string().uuid().optional(),
  bucket: z.enum(['DPD_1_30', 'DPD_31_60', 'DPD_61_90', 'DPD_90_PLUS']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

@Controller('recovery')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Require('recovery.view')
  @Get('stages')
  stages() {
    return this.recovery.stages();
  }

  @Require('recovery.configure')
  @Put('stages')
  saveStage(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.recovery.saveStage(ctx, parse(stageDefinitionSchema, body));
  }

  @Require('recovery.view')
  @Get('settings')
  settings() {
    return this.recovery.settings();
  }

  @Require('recovery.configure')
  @Put('settings')
  saveSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.recovery.saveSettings(ctx, parse(recoverySettingsSchema, body).autoOpenDpd);
  }

  @Require('recovery.view')
  @Get('cases')
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.recovery.list(ctx.auth, parse(listQuery, q));
  }

  @Require('recovery.manage')
  @Get('candidates')
  candidates(@Ctx() ctx: RequestContext) {
    return this.recovery.candidates(ctx.auth);
  }

  @Require('recovery.view')
  @Get('approvals')
  approvals(@Ctx() ctx: RequestContext) {
    return this.recovery.approvals(ctx.auth);
  }

  @Require('recovery.view')
  @Get('cases/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.recovery.get(ctx.auth, id);
  }

  @Require('recovery.manage')
  @Post('cases')
  open(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.recovery.open(ctx, parse(recoveryOpenSchema, body));
  }

  @Require('recovery.note')
  @Post('cases/:id/actions')
  action(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.addAction(ctx, id, parse(recoveryActionSchema, body));
  }

  @Require('recovery.manage')
  @Post('cases/:id/owner')
  @HttpCode(200)
  owner(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.setOwner(ctx, id, parse(recoveryOwnerSchema, body).ownerEmployeeId);
  }

  @Require('recovery.manage')
  @Post('cases/:id/stage')
  @HttpCode(200)
  stage(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.moveStage(ctx, id, parse(recoveryStageSchema, body));
  }

  @Require('recovery.approve')
  @RequireRecentAuth()
  @Post('cases/:id/stage/approve')
  @HttpCode(200)
  approveStage(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.decideStage(ctx, id, true, parse(decisionSchema, body ?? {}).note);
  }

  @Require('recovery.approve')
  @Post('cases/:id/stage/reject')
  @HttpCode(200)
  rejectStage(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.decideStage(ctx, id, false, parse(rejectSchema, body).note);
  }

  @Require('recovery.manage')
  @Post('cases/:id/close')
  @HttpCode(200)
  close(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.close(ctx, id, parse(recoveryCloseSchema, body).reason);
  }

  @Require('recovery.manage')
  @Post('cases/:id/repossess')
  repossess(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.repossess(ctx, id, parse(repossessSchema, body));
  }

  @Require('recovery.manage')
  @Post('cases/:id/assets/:assetId/release')
  @HttpCode(200)
  release(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('assetId', ParseUUIDPipe) assetId: string, @Body() body: unknown) {
    return this.recovery.release(ctx, id, assetId, parse(releaseSchema, body).reason);
  }

  @Require('recovery.manage')
  @Post('cases/:id/sales')
  requestSale(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.requestSale(ctx, id, parse(saleRequestSchema, body));
  }

  @Require('recovery.approve')
  @RequireRecentAuth()
  @Post('sales/:id/approve')
  @HttpCode(200)
  approveSale(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.decideSale(ctx, id, true, parse(decisionSchema, body ?? {}).note);
  }

  @Require('recovery.approve')
  @Post('sales/:id/reject')
  @HttpCode(200)
  rejectSale(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.decideSale(ctx, id, false, parse(rejectSchema, body).note);
  }

  @Require('loan.write_off_request')
  @Post('cases/:id/write-off')
  requestWriteOff(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.requestWriteOff(ctx, id, parse(writeOffRequestSchema, body).reason);
  }

  @Require('loan.write_off')
  @RequireRecentAuth()
  @Post('write-offs/:id/approve')
  @HttpCode(200)
  approveWriteOff(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.decideWriteOff(ctx, id, true, parse(decisionSchema, body ?? {}).note);
  }

  @Require('loan.write_off')
  @Post('write-offs/:id/reject')
  @HttpCode(200)
  rejectWriteOff(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.recovery.decideWriteOff(ctx, id, false, parse(rejectSchema, body).note);
  }
}
