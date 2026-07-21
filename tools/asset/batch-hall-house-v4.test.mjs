import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { batchArchitectureBuilding } from "./batch-architecture-building.mjs";

const INPUT=new URL("../../assets/buildings/functional-hall-house-v4.glb",import.meta.url).pathname;
const OUTPUT=new URL("../../assets/buildings/functional-hall-house-v4-lod.glb",import.meta.url).pathname;
const SOURCE_SHA="90b66c071be6b5fcfcffc24acde3fc6abc22c9c1fb7201c90ecb175682b03c43";
const OUTPUT_SHA="8fcb0c7df015d7681d078f3ec6619411f7ec368c87705f5bf963fbb528865493";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");

test("architecture hall-house batching is deterministic and compiler-authoritative",async()=>{
  const [source,output]=await Promise.all([readFile(INPUT),readFile(OUTPUT)]);
  assert.equal(sha(source),SOURCE_SHA);assert.equal(sha(output),OUTPUT_SHA);
  const jsonLength=output.readUInt32LE(12),g=JSON.parse(output.subarray(20,20+jsonLength).toString().trimEnd()),batch=g.asset.extras.liminaStaticBatch;
  assert.equal(batch.schema,"limina.static-batch/1");assert.equal(batch.sourceSha256,SOURCE_SHA);assert.equal(batch.lodStrategy,"whole-primitive-semantic-filter");
  assert.deepEqual(batch.measurements.map(({level,triangles,draws,sourcePrimitiveCount})=>({level,triangles,draws,sourcePrimitiveCount})),[
    {level:0,triangles:31572,draws:19,sourcePrimitiveCount:484},
    {level:1,triangles:5060,draws:9,sourcePrimitiveCount:280},
    {level:2,triangles:2756,draws:9,sourcePrimitiveCount:232},
  ]);
  assert.equal(g.nodes[batch.doorRoot].extras.limina.id,"door/front");assert.ok(g.nodes[batch.doorRoot].mesh!==undefined);
  assert.equal(g.nodes.filter(node=>node.extras?.visualBatchRange).length,484);
  const temp=`${OUTPUT}.determinism-${process.pid}`;try{const evidence=await batchArchitectureBuilding(INPUT,temp,SOURCE_SHA);assert.equal(evidence.sha256,OUTPUT_SHA);assert.deepEqual(await readFile(temp),output);}finally{await rm(temp,{force:true});}
});
