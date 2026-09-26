import test from 'node:test'
import assert from 'node:assert/strict'
import {transitionJob,validateJob,validatePolicy} from '../src/domain.js'
test('job capacity uses evaluator stake, not illustrative accuracy',()=>{
 const v={title:'Research brief',brief:'A sufficiently detailed acceptance criterion and deliverable.',budget:1001,deadline:'2030-01-01'}
 assert.match(validateJob(v,{stake:5000},0),/capacity/)
 assert.equal(validateJob({...v,budget:1000},{stake:5000},0),'')
})
test('cannot skip funding or reopen terminal expiry',()=>{
 assert.throws(()=>transitionJob({status:'Open'},'Completed'),/cannot move/)
 assert.throws(()=>transitionJob({status:'Expired'},'Funded'),/cannot move/)
})
test('challenge window closes after 72 hours',()=>{
 const job={status:'Completed',completedAt:'2026-09-26T00:00:00Z',history:[]}
 assert.equal(transitionJob(job,'Challenged','2026-09-29T00:00:00Z').status,'Challenged')
 assert.throws(()=>transitionJob(job,'Challenged','2026-09-29T00:00:01Z'),/ended/)
})
test('transition preserves history and does not mutate source job',()=>{
 const job={status:'Funded',history:[{status:'Funded',at:'2026-09-26T00:00:00Z'}]}
 const result=transitionJob(job,'Submitted');assert.equal(result.history.length,2);assert.equal(job.history.length,1)
})
test('permission caps and expiry must be coherent',()=>{
 const p={total:10000,perTrade:500,drawdown:5,expires:'2030-01-01',tokens:'USDG',venues:'Allowlisted venue'}
 assert.equal(validatePolicy(p,0),'')
 assert.match(validatePolicy({...p,perTrade:10001},0),/Per-trade/)
 assert.match(validatePolicy({...p,drawdown:0},0),/Drawdown/)
 assert.match(validatePolicy({...p,expires:'2020-01-01'},Date.now()),/future/)
})
