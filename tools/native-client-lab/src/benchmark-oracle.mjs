export function evaluateAcceptance({ launcherExit, nativeExit, clientFinal, testExit, exactEdit, testsUnchanged, servedModel }) {
  const workflowAccepted = launcherExit === 0 && nativeExit === 0 && clientFinal === true
    && testExit === 0 && exactEdit === true && testsUnchanged === true;
  const providerVerified = servedModel === 'gpt-6-pro';
  return { workflow_accepted: workflowAccepted, provider_verified: providerVerified, accepted: workflowAccepted && providerVerified };
}
