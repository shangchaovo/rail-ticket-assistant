import { dispatch } from '@/lib/rail-api';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
export async function GET(req:Request,context:Context){return dispatch(req,(await context.params).path);}
export async function POST(req:Request,context:Context){return dispatch(req,(await context.params).path);}
export async function PATCH(req:Request,context:Context){return dispatch(req,(await context.params).path);}
export async function PUT(req:Request,context:Context){return dispatch(req,(await context.params).path);}
export async function DELETE(req:Request,context:Context){return dispatch(req,(await context.params).path);}
