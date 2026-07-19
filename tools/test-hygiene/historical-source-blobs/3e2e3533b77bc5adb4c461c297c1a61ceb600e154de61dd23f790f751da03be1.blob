import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";

type Hash=`sha256:${string}`;
type Exact={readonly path:string;readonly sha256:Hash;readonly contentHash:Hash};
export interface Fb4CaptureProvenance {
  readonly schema:"limina.fb4-capture-provenance/v1";
  readonly coverage:"complete";
  readonly captureEvidence:Exact;
  readonly trace:{readonly sha256:Hash;readonly byteLength:number};
  readonly subject:{readonly candidateId:string;readonly manifest:Exact;readonly glb:Exact&{readonly bytes:number};readonly reviewAuthority:Exact;readonly irHash:Hash};
  readonly environment:{readonly authority:Exact;readonly runtimeBundle:Exact;readonly shot:string;readonly context:string};
  readonly execution:{readonly binary:Exact&{readonly bytes:number};readonly orchestrator:{readonly kind:"bun";readonly version:string;readonly sha256:Hash;readonly bytes:number};readonly entrySources:readonly string[];readonly sources:readonly(Exact&{readonly bytes:number})[];readonly argv:readonly string[];readonly platform:{readonly arch:string;readonly os:string};readonly timestampEnvironmentKeys:readonly[]};
  readonly gpuSafety:{readonly bootId:string;readonly timestampQueriesEnabled:false;readonly xidObserved:false;readonly preflightSource:"journalctl-kernel-current-boot";readonly liveFollower:"journalctl-kernel-follow-current-boot";readonly redundantPollMs:250;readonly postflightSource:"journalctl-kernel-current-boot"};
  readonly outputs:readonly{readonly id:string;readonly path:string;readonly width:number;readonly height:number;readonly pngSha256:Hash;readonly pngByteLength:number;readonly rgbaContentHash:Hash}[];
  readonly closureHash:Hash;
}
const HASH=/^sha256:[0-9a-f]{64}$/,BOOT=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact=(value:any,label:string)=>{if(!value?.path||value.path.startsWith("/")||value.path.includes("\\")||value.path.split("/").includes("..")||!HASH.test(value.sha256)||!HASH.test(value.contentHash))throw new Error(`${label} is not an exact workspace file`);};
const closure=(value:Omit<Fb4CaptureProvenance,"closureHash">):Hash=>`sha256:${sha256(canonicalStringify(value))}`;
export function buildFb4CaptureProvenance(input:Omit<Fb4CaptureProvenance,"schema"|"coverage"|"closureHash">):Fb4CaptureProvenance{
  return validateFb4CaptureProvenance({...input,schema:"limina.fb4-capture-provenance/v1",coverage:"complete",closureHash:closure({...input,schema:"limina.fb4-capture-provenance/v1",coverage:"complete"})});
}
export function validateFb4CaptureProvenance(value:any):Fb4CaptureProvenance{
  if(value?.schema!=="limina.fb4-capture-provenance/v1"||value.coverage!=="complete"||!HASH.test(value.closureHash))throw new Error("FB-4 capture provenance identity is invalid");
  exact(value.captureEvidence,"captureEvidence");exact(value.subject?.manifest,"subject.manifest");exact(value.subject?.glb,"subject.glb");exact(value.subject?.reviewAuthority,"subject.reviewAuthority");exact(value.environment?.authority,"environment.authority");exact(value.environment?.runtimeBundle,"environment.runtimeBundle");exact(value.execution?.binary,"execution.binary");
  if(!HASH.test(value.trace?.sha256)||!Number.isSafeInteger(value.trace?.byteLength)||value.trace.byteLength<1||!HASH.test(value.subject?.irHash)||!value.subject?.candidateId)throw new Error("FB-4 capture provenance trace/subject is invalid");
  if(!Array.isArray(value.execution?.entrySources)||value.execution.entrySources.length<3||!Array.isArray(value.execution?.sources)||value.execution.sources.length<3||new Set(value.execution.sources.map((entry:any)=>entry.path)).size!==value.execution.sources.length)throw new Error("FB-4 capture producer source closure is incomplete");
  for(const source of value.execution.sources){exact(source,"execution.sources[]");if(!Number.isSafeInteger(source.bytes)||source.bytes<1)throw new Error("capture producer source byte length is invalid");}
  if(value.execution.orchestrator?.kind!=="bun"||!value.execution.orchestrator.version||!HASH.test(value.execution.orchestrator.sha256)||value.execution.platform?.arch!=="arm64"||!value.execution.platform.os||value.execution.timestampEnvironmentKeys?.length!==0)throw new Error("FB-4 capture execution environment is unsafe or incomplete");
  if(!Array.isArray(value.execution.argv)||value.execution.argv.length<2||!BOOT.test(value.gpuSafety?.bootId)||value.gpuSafety.timestampQueriesEnabled!==false||value.gpuSafety.xidObserved!==false||value.gpuSafety.preflightSource!=="journalctl-kernel-current-boot"||value.gpuSafety.liveFollower!=="journalctl-kernel-follow-current-boot"||value.gpuSafety.redundantPollMs!==250||value.gpuSafety.postflightSource!=="journalctl-kernel-current-boot")throw new Error("FB-4 capture GPU safety provenance is incomplete");
  if(!Array.isArray(value.outputs)||value.outputs.length<1||new Set(value.outputs.map((entry:any)=>entry.id)).size!==value.outputs.length||value.outputs.some((entry:any)=>!entry.id||!entry.path||!Number.isSafeInteger(entry.width)||entry.width<1||!Number.isSafeInteger(entry.height)||entry.height<1||!HASH.test(entry.pngSha256)||!HASH.test(entry.rgbaContentHash)||!Number.isSafeInteger(entry.pngByteLength)||entry.pngByteLength<1))throw new Error("FB-4 capture output provenance is incomplete");
  const {closureHash,...body}=value;if(closure(body)!==closureHash)throw new Error("FB-4 capture provenance closure hash drifted");return Object.freeze(value);
}
