'use strict'

const retry = require('retry')
const { request: httpRequest } = require('http')
const { request: httpsRequest } = require('https')

// TODO: avoid using dd-trace internals. Make this a separate module?
const docker = require('../../exporters/common/docker')
const FormData = require('../../exporters/common/form-data')
const { storage } = require('../../../../datadog-core')
const version = require('../../../../../package.json').version

const containerId = docker.id()

function sendRequest (options, form, callback) {
  const request = options.protocol === 'https:' ? httpsRequest : httpRequest

  const store = storage.getStore()
  storage.enterWith({ noop: true })
  const req = request(options, res => {
    if (res.statusCode >= 400) {
      const error = new Error(`HTTP Error ${res.statusCode}`)
      error.status = res.statusCode
      callback(error)
    } else {
      callback(null, res)
    }
  })
  req.on('error', callback)
  if (form) form.pipe(req)
  storage.enterWith(store)
}

function getBody (stream, callback) {
  const chunks = []
  stream.on('error', callback)
  stream.on('data', chunk => chunks.push(chunk))
  stream.on('end', () => {
    callback(null, Buffer.concat(chunks))
  })
}

function computeRetries (uploadTimeout) {
  let tries = 0
  while (tries < 2 || uploadTimeout > 1000) {
    tries++
    uploadTimeout /= 2
  }
  return [tries, Math.floor(uploadTimeout)]
}

class AgentExporter {
  constructor ({ url, logger, uploadTimeout } = {}) {
    this._url = url
    this._logger = logger

    const [backoffTries, backoffTime] = computeRetries(uploadTimeout)

    this._backoffTime = backoffTime
    this._backoffTries = backoffTries
  }

  export ({ profiles, start, end, tags }) {
    const fields = []

    function typeToFile (type) {
      return `${type}.pprof`
    }

    const event = JSON.stringify({
      attachments: Object.keys(profiles).map(typeToFile),
      start: start.toISOString(),
      end: end.toISOString(),
      family: 'node',
      version: '4',
      tags_profiler: [
        'language:javascript',
        'runtime:nodejs',
        `runtime_arch:${process.arch}`,
        `runtime_os:${process.platform}`,
        `runtime_version:${process.version}`,
        `process_id:${process.pid}`,
        `profiler_version:${version}`,
        'format:pprof',
        ...Object.entries(tags).map(([key, value]) => `${key}:${value}`)
      ].join(',')
    })

    fields.push(['event', event, {
      filename: 'event.json',
      contentType: 'application/json'
    }])

    this._logger.debug(() => {
      return `Building agent export report:\n${event}`
    })

    for (const [type, buffer] of Object.entries(profiles)) {
      this._logger.debug(() => {
        const bytes = buffer.toString('hex').match(/../g).join(' ')
        return `Adding ${type} profile to agent export: ` + bytes
      })

      const filename = typeToFile(type)
      fields.push([filename, buffer, {
        filename,
        contentType: 'application/octet-stream'
      }])
    }

    return new Promise((resolve, reject) => {
      const operation = retry.operation({
        randomize: true,
        minTimeout: this._backoffTime,
        retries: this._backoffTries,
        unref: true
      })

      operation.attempt((attempt) => {
        const form = new FormData()

        for (const [key, value, options] of fields) {
          form.append(key, value, options)
        }

        const options = {
          method: 'POST',
          path: '/profiling/v1/input',
          headers: {
            'DD-EVP-ORIGIN': 'dd-trace-js',
            'DD-EVP-ORIGIN-VERSION': version,
            ...form.getHeaders()
          },
          timeout: this._backoffTime * Math.pow(2, attempt)
        }

        if (containerId) {
          options.headers['Datadog-Container-ID'] = containerId
        }

        if (this._url.protocol === 'unix:') {
          options.socketPath = this._url.pathname
        } else {
          options.protocol = this._url.protocol
          options.hostname = this._url.hostname
          options.port = this._url.port
        }

        this._logger.debug(() => {
          return `Submitting profiler agent report attempt #${attempt} to: ${JSON.stringify(options)}`
        })

        sendRequest(options, form, (err, response) => {
          if (operation.retry(err)) {
            this._logger.error(`Error from the agent: ${err.message}`)
            return
          } else if (err) {
            reject(new Error('Profiler agent export back-off period expired'))
            return
          }

          getBody(response, (err, body) => {
            if (err) {
              this._logger.error(`Error reading agent response: ${err.message}`)
            } else {
              this._logger.debug(() => {
                const bytes = (body.toString('hex').match(/../g) || []).join(' ')
                return `Agent export response: ${bytes}`
              })
            }
          })

          resolve()
        })
      })
    })
  }
}

module.exports = { AgentExporter, computeRetries }
