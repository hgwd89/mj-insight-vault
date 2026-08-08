import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getVerifiedThemeCandidateStatus, runVerifiedThemeCandidateWorkerStep } from '@/lib/verifiedThemeCandidateWorker';
export const runtime='nodejs';
export const maxDuration=180;
export async function GET(req:NextRequest){try{requireAppPassword(req);return Response.json(await getVerifiedThemeCandidateStatus());}catch(error){return jsonError(error);}}
export async function POST(req:NextRequest){try{requireAppPassword(req);await req.json().catch(()=>({}));const step=await runVerifiedThemeCandidateWorkerStep();return Response.json({step,...(await getVerifiedThemeCandidateStatus())});}catch(error){return jsonError(error);}}
