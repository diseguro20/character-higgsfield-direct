// Cliente da API local.
// Character Online: resposta 401 fora do login = sessão vencida; o app volta para a tela de entrada.
let authLost = null
export const onAuthLost = fn => { authLost = fn }
const lost = (status, url) => { if (status === 401 && !String(url).startsWith('/api/auth/')) authLost?.() }

// sem rede ou servidor fora do ar: o fetch rejeita com o texto do navegador, em inglês ("Failed to fetch", "Load
// failed"). A tela mostra este no lugar (sem status: não é sessão vencida). O fetch deste arquivo é o do navegador
// com essa troca (lido na hora da chamada: os testes trocam o globalThis.fetch).
export const OFFLINE = 'Não consegui falar com o Character. Confira a sua internet e tente de novo.'
const fetch = async (url, opts) => { try { return await globalThis.fetch(url, opts) } catch { throw new Error(OFFLINE) } }

// o: { signal } para cortar uma consulta presa (AbortController)
async function req(method, url, body, o) {
  const opts = { method, headers: { 'X-Character': '1' } }
  if (o?.signal) opts.signal = o.signal
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    lost(res.status, url)
    throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status, data })
  }
  return data
}

export const api = {
  get: (url, o) => req('GET', url, undefined, o),
  post: (url, body = {}) => req('POST', url, body),
  put: (url, body = {}) => req('PUT', url, body),
  patch: (url, body = {}) => req('PATCH', url, body),
  del: url => req('DELETE', url),
}

// Envia arquivo bruto (sem multipart) mostrando o progresso.
export function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const sep = url.includes('?') ? '&' : '?'
    xhr.open('POST', `${url}${sep}name=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('X-Character', '1')
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => {
      let data = {}
      try { data = JSON.parse(xhr.responseText) } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else { lost(xhr.status, url); reject(new Error(data.error || `Erro ${xhr.status}`)) }
    }
    xhr.onerror = () => reject(new Error(OFFLINE))
    xhr.send(file)
  })
}

// Envia vários arquivos num formulário (multipart), cada um com o nome do campo (ex.: credenciais da conta no admin)
export async function uploadForm(url, files) {
  const form = new FormData()
  for (const [field, f] of Object.entries(files)) form.append(field, f, f.name)
  const res = await fetch(url, { method: 'POST', headers: { 'X-Character': '1' }, body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    lost(res.status, url)
    throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status })
  }
  return data
}
