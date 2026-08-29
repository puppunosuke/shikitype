// 拓男の実機確認で見つかった不具合の回帰テスト。
// 1) サイドバー入口ボタン／アカウントダイアログに g_xxxx のような読めないハッシュ(login_id)が
//    そのまま出ていた → サーバpublicAccount()が返すname（Googleの表示名）があればそちらを表示する。
// 2) 既にGoogle連携済みなのに「Googleアカウントを連携」ボタンが出ていた → googleLinked===true なら隠す。
//
// 実際のGoogle OAuth資格情報が無い環境のため、completeGoogleLogin()/restoreCloudSession()が
// 受け取ったサーバレスポンス（{ user: { id, name, googleLinked } }）を反映した「後」の状態を
// window.__neoApp.setCloudAccountForTest() で直接再現し、表示ロジックだけを検証する
// （＝サーバ通信そのものはモック、cloudAccount反映後の描画は実コードパス）。
import { chromium } from '../spike/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8893/app.html';
let passed = 0;
const failures = [];
function ok(label, value, detail = value) {
  if (value) { passed++; console.log(`  OK  ${label}`); }
  else { failures.push({ label, detail }); console.log(`  FAIL ${label}: ${JSON.stringify(detail)}`); }
}

const main = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });

  const GOOGLE_HASH_ID = 'g_e166767ddd6469d87aff2e662ca9';

  // --- ケース1: Google連携済み・表示名あり（実機で報告されたケース） ---
  await page.evaluate((userId) => {
    window.__neoApp.setCloudAccountForTest({ userId, displayName: '拓男', googleLinked: true });
  }, GOOGLE_HASH_ID);

  const toggleText1 = await page.locator('#account-toggle span:last-child').textContent();
  ok('入口ボタンにg_ハッシュではなくGoogle表示名が出る', toggleText1 === '拓男', toggleText1);
  ok('入口ボタンに読めないハッシュが残っていない', !toggleText1.includes(GOOGLE_HASH_ID), toggleText1);

  await page.click('#account-toggle');
  const dialogUserId = await page.locator('#account-user-id').textContent();
  ok('アカウントダイアログにもg_ハッシュではなく表示名が出る', dialogUserId === '拓男', dialogUserId);

  const linkButtonHidden = await page.locator('#google-link-submit').evaluate((el) => el.hidden);
  ok('連携済みなら「Googleアカウントを連携」ボタンが出ない', linkButtonHidden, linkButtonHidden);
  const linkStatusVisible = await page.locator('#google-link-status').evaluate((el) => !el.hidden);
  ok('連携済みなら「連携済み」の控えめな表示が出る', linkStatusVisible, linkStatusVisible);
  const linkStatusText = await page.locator('#google-link-status').textContent();
  ok('連携済み表示に意味のある文言が入る', linkStatusText.includes('連携'), linkStatusText);

  // --- ケース2: 同じアカウントでまだ未連携（name取得前 or パスワードのみ）
  //     → 少なくとも「連携済み」の誤表示は出ない。ボタン自体の表示可否は
  //     prepareGoogleLogin()（実際のGoogleスクリプト読込）側の責務であり、
  //     ローカル環境にはGoogle接続情報が無いため実際には出ない（account-ui.test.mjsで確認済み）。 ---
  await page.evaluate((userId) => {
    window.__neoApp.setCloudAccountForTest({ userId, displayName: null, googleLinked: false });
  }, GOOGLE_HASH_ID);
  const linkStatusHiddenWhenUnlinked = await page.locator('#google-link-status').evaluate((el) => el.hidden);
  ok('未連携では「連携済み」表示が出ない', linkStatusHiddenWhenUnlinked, linkStatusHiddenWhenUnlinked);

  // --- ケース3: 表示名が無い（パスワード登録アカウント）は従来通りidを表示 ---
  const toggleText3 = await page.locator('#account-toggle span:last-child').textContent();
  ok('表示名が無ければ従来通りidを表示する（パスワード登録アカウントの互換）', toggleText3 === GOOGLE_HASH_ID, toggleText3);

  // --- ケース4: 長い表示名でも既存の省略表示(CSS text-overflow: ellipsis)が効く ---
  const longName = 'とても長いGoogleアカウントの表示名サンプルたくおたくおたくお12345';
  await page.evaluate((data) => {
    window.__neoApp.setCloudAccountForTest(data);
  }, { userId: GOOGLE_HASH_ID, displayName: longName, googleLinked: true });
  const overflowState = await page.evaluate(() => {
    const toggle = document.getElementById('account-toggle');
    return { scrollWidth: toggle.scrollWidth, clientWidth: toggle.clientWidth };
  });
  ok('長い表示名でもaccount-toggleが横に溢れない（既存ellipsis省略が効く）', overflowState.scrollWidth <= overflowState.clientWidth + 1, overflowState);

  // --- 後始末: 匿名状態へ戻す ---
  await page.evaluate(() => {
    window.__neoApp.setCloudAccountForTest({ userId: null, displayName: null, googleLinked: false });
  });
  const backToAnonymous = await page.locator('#account-toggle span:last-child').textContent();
  ok('匿名へ戻すと「ログイン」表示に戻る', backToAnonymous === 'ログイン', backToAnonymous);

  ok('この一連の操作で通信/実行エラーを出さない', errors.length === 0, errors);

  await browser.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) process.exit(1);
};
main();
