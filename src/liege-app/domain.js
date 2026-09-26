export const nextStates={Draft:['Open'],Open:['Funded','Expired'],Funded:['Submitted','Expired'],Submitted:['Completed','Rejected'],Completed:['Challenged'],Rejected:['Challenged'],Challenged:['Completed','Rejected'],Expired:[]}
export function transitionJob(job,status,now=new Date().toISOString()){
  if(!nextStates[job.status]?.includes(status))throw new Error(`A ${job.status.toLowerCase()} job cannot move to ${status.toLowerCase()}.`)
  if(status==='Challenged'&&(!job.completedAt||Date.parse(now)-Date.parse(job.completedAt)>72*3600*1000))throw new Error('The 72-hour challenge window has ended.')
  return {...job,status,history:[...(job.history||[]),{status,at:now}],...(['Completed','Rejected'].includes(status)?{completedAt:now}:{})}
}
export function validateJob(values,evaluator,now=Date.now()){
  if(values.title.trim().length<5)return'Give the job a title of at least 5 characters.'
  if(values.brief.trim().length<30)return'Describe the deliverable and acceptance criteria in at least 30 characters.'
  const budget=Number(values.budget)
  if(!Number.isFinite(budget)||budget<=0)return'Enter a positive USDG budget.'
  if(!evaluator||budget>evaluator.stake/5)return'The job budget exceeds this evaluator’s capacity (stake ÷ 5).'
  if(!values.deadline||Date.parse(values.deadline+'T23:59:59')<=now)return'Choose a deadline in the future.'
  return''
}
export function validatePolicy(p,now=Date.now()){
  if(!Number.isFinite(+p.total)||+p.total<=0)return'Total cap must be positive.'
  if(!Number.isFinite(+p.perTrade)||+p.perTrade<=0||+p.perTrade>+p.total)return'Per-trade cap must be positive and no greater than the total cap.'
  if(!Number.isFinite(+p.drawdown)||+p.drawdown<=0||+p.drawdown>100)return'Drawdown must be greater than 0% and at most 100%.'
  if(!p.expires||Date.parse(p.expires+'T23:59:59')<=now)return'Choose a future expiry.'
  if(!p.tokens.trim()||!p.venues.trim())return'Specify at least one allowed token and venue.'
  return''
}
