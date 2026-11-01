export default class {
  onTestCaseReady(testCase) {
    console.log(
      JSON.stringify({
        case: testCase.fullName,
        budgetMs: testCase.options.timeout ?? testCase.project.config.testTimeout,
      }),
    );
  }
}
