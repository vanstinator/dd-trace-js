'use strict'

const { storage } = require('../../datadog-core')
const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SOURCE_FILE,
  TEST_CONFIGURATION_BROWSER_NAME
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED
} = require('../../dd-trace/src/ci-visibility/telemetry')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')

class PlaywrightPlugin extends CiPlugin {
  static get id () {
    return 'playwright'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()

    this.addSub('ci:playwright:session:finish', ({ status, onDone }) => {
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testSessionSpan.setTag(TEST_STATUS, status)

      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      appClosingTelemetry()
      this.tracer._exporter.flush(onDone)
    })

    this.addSub('ci:playwright:test-suite:start', (testSuiteAbsolutePath) => {
      const store = storage.getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)

      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'playwright'
      )

      const testSuiteSpan = this.tracer.startSpan('playwright.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      this.enter(testSuiteSpan, store)

      this._testSuites.set(testSuite, testSuiteSpan)
    })

    this.addSub('ci:playwright:test-suite:finish', (status) => {
      const store = storage.getStore()
      const span = store && store.span
      if (!span) return
      span.setTag(TEST_STATUS, status)
      span.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    })

    this.addSub('ci:playwright:test:start', ({ testName, testSuiteAbsolutePath, testSourceLine, browserName }) => {
      const store = storage.getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const span = this.startTestSpan(testName, testSuite, testSourceFile, testSourceLine, browserName)

      this.enter(span, store)
    })
    this.addSub('ci:playwright:test:finish', ({ testStatus, steps, error, extraTags }) => {
      const store = storage.getStore()
      const span = store && store.span
      if (!span) return

      span.setTag(TEST_STATUS, testStatus)

      if (error) {
        span.setTag('error', error)
      }
      if (extraTags) {
        span.addTags(extraTags)
      }

      steps.forEach(step => {
        const stepStartTime = step.startTime.getTime()
        const stepSpan = this.tracer.startSpan('playwright.step', {
          childOf: span,
          startTime: stepStartTime,
          tags: {
            [COMPONENT]: this.constructor.id,
            'playwright.step': step.title,
            [RESOURCE_NAME]: step.title
          }
        })
        if (step.error) {
          stepSpan.setTag('error', step.error)
        }
        stepSpan.finish(stepStartTime + step.duration)
      })

      span.finish()

      this.telemetry.ciVisEvent(
        TELEMETRY_EVENT_FINISHED,
        'test',
        { hasCodeOwners: !!span.context()._tags[TEST_CODE_OWNERS] }
      )

      finishAllTraceSpans(span)
    })
  }

  startTestSpan (testName, testSuite, testSourceFile, testSourceLine, browserName) {
    const testSuiteSpan = this._testSuites.get(testSuite)

    const extraTags = {
      [TEST_SOURCE_START]: testSourceLine
    }
    if (testSourceFile) {
      extraTags[TEST_SOURCE_FILE] = testSourceFile || testSuite
    }
    if (browserName) {
      extraTags[TEST_CONFIGURATION_BROWSER_NAME] = browserName
    }

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = PlaywrightPlugin
