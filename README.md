# Silly Cat Crochê — site

Site institucional + lojinha da **Silly Cat Crochê**, em um único arquivo `index.html` (HTML, CSS e JavaScript juntos), pronto para o GitHub Pages. A gatinha mascote é um desenho em SVG embutido no próprio arquivo — não depende de imagem externa, então nunca quebra.

---

## ✏️ O que você precisa preencher

Abra o `index.html` e procure por **`★★★ EDITE AQUI`** (são só 2 pontos):

### 1. Seu link de PIX
No bloco `LINKS`, troque o texto pelo link do seu **Google Forms**:
```js
const LINKS = {
  pixForm: "https://forms.gle/SEU_FORMULARIO"
};
```

### 2. Seus produtos
No bloco `PRODUTOS`, edite cada peça. O importante é `olx` (link do anúncio para pagamento com cartão):
```js
{ nome:"Gatinho Silly", preco:"R$ 89,90", desc:"...", img:"img/gatinho.jpg", olx:"https://olx.com.br/seu-anuncio" },
```
- `img:""` → mostra a gatinha como capa. Para usar foto, coloque o arquivo na pasta `img/` e aponte o caminho (ex.: `img/snorlax.jpg`).
- Pode adicionar ou remover quantos produtos quiser — é só copiar/colar as linhas.

> 💡 Enquanto um link estiver vazio ou com `COLE_AQUI`, o botão mostra um aviso fofo ("Esse link ainda está sendo preparado 🧶") em vez de levar a uma página quebrada. Assim dá pra publicar antes de ter tudo pronto.

---

## 📷 Fotos (opcional, mas deixa bem mais profissional)

Crie uma pasta `img/` ao lado do `index.html` e adicione suas fotos. Depois, no `index.html`, procure pelos comentários `★ Troque por...` e substitua o desenho da gatinha por uma foto real:

| Onde | Procure no código | Troque por |
|---|---|---|
| Foto da Lili | `★ Troque o bloco abaixo por uma foto real` | `<img src="img/lili.jpg" alt="Lili, a gata Silly">` |
| Foto da Anna | `★ Troque por:  <img src="img/anna.jpg"...` | `<img src="img/anna.jpg" alt="Anna">` |
| Foto da Samara | `★ Troque por:  <img src="img/samara.jpg"...` | `<img src="img/samara.jpg" alt="Samara">` |
| Fotos dos produtos | bloco `PRODUTOS` | preencha o campo `img` |

**Prévia do link no Instagram/WhatsApp:** adicione um `og-image.png` (1200×630, pode ser o logo) na raiz e ajuste a URL na tag `og:image` (lá no topo do arquivo).

---

## 🚀 Como publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `silly-cat`).
2. Envie os arquivos para o repositório:
   - `index.html` (e a pasta `img/`, se tiver).
3. No repositório, vá em **Settings → Pages**.
4. Em **Source**, escolha **Deploy from a branch**.
5. Selecione a branch **main** e a pasta **/(root)** → **Save**.
6. Aguarde ~1 minuto. O site fica no ar em:
   `https://SEU-USUARIO.github.io/silly-cat/`

> Quer um endereço próprio (ex.: `sillycatcroche.com.br`)? Dá pra ligar um domínio depois em **Settings → Pages → Custom domain**.

Para subir pelo terminal:
```bash
git init
git add .
git commit -m "Site Silly Cat Crochê"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/silly-cat.git
git push -u origin main
```

---

## 🛒 Como funcionam as compras

- **PIX** → o botão abre seu Google Forms. O cliente escolhe a peça, preenche os dados e você confirma + envia a chave PIX.
- **Cartão** → o botão leva ao anúncio da peça na OLX, onde o cliente paga com cartão (com opção de parcelar).
- **Catálogo completo** → os botões "Catálogo na Moira" levam ao seu perfil atual: `app.moirabr.com.br/perfil/silly-cat`.

---

## 🎨 Identidade visual usada

- **Cores:** vermelho `#E23B30`, rosa `#F6A9C6`, azul `#AECCEE`, amarelo `#F4C748`, creme `#FBF1E1`.
- **Fontes:** *Special Elite* (títulos tipo máquina de escrever), *Quicksand* (texto), *Pacifico* (frases). Carregadas pelo Google Fonts.
- **Marca registrada do site:** títulos em "azulejos" estilo Scrabble + a gatinha em SVG sobre os raios de sol (igual ao logo).

Tudo é responsivo (funciona bem no celular), tem foco visível para teclado e respeita "reduzir movimento" do sistema.
