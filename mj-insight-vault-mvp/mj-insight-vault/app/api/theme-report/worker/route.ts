import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getVerifiedThemeReportStatus, runVerifiedThemeReportWorkerStep } from '@/lib/verifiedThemeReportWorker';
export const runtime='nodejs';
export const maxDuration=180;
export async function GET(req:NextRequest){try{requireAppPassword(req);return Response.json(await getVerifiedThemeReportStatus());}catch(error){return jsonError(error);}}
export async function POST(req:NextRequest){try{requireAppPassword(req);await req.json().catch(()=>({}));const step=await runVerifiedThemeReportWorkerStep();return Response.json({step,...(await getVerifiedThemeReportStatus())});}catch(error){return jsonError(error);}}
