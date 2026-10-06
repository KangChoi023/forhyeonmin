# 💌 소개팅 시뮬레이션

호스트(그녀)가 이야기를 건네면 참가자들이 대답하고, 호스트가 가장 마음에 드는 대답을 골라 ❤ 점수를 줍니다.
호스트가 소개팅을 종료하면 점수 순으로 순위가 발표됩니다.

- 빌드 없는 정적 사이트 (HTML/CSS/JS) → Vercel에 그대로 배포
- 실시간 동기화·저장은 Supabase (무료 플랜으로 충분)

## 진행 방식

1. 호스트가 **방 만들기** → 상단 **링크 복사**로 초대 링크 공유
2. 참가자는 링크로 들어와 닉네임 입력
3. 호스트가 이야기를 보내면 참가자들이 답변 (선택 전까지 수정 가능)
4. 호스트는 답변을 **이름 없이(A, B, C…)** 보고 하나를 선택 → 그 사람 +1점, 작성자 공개
5. 반복하다가 **종료** → 모두의 화면에 순위 발표

새로고침해도 같은 기기·브라우저면 자기 자리로 돌아옵니다.

## 설정 (처음 한 번)

### 1. Supabase
1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성
2. **SQL Editor**에 `supabase/schema.sql` 내용을 붙여넣고 **Run**
3. **Project Settings → API**에서 `Project URL`과 `anon public`(또는 publishable) 키 복사
4. `config.js`에 붙여넣기

> anon 키는 브라우저 공개용이라 깃허브에 올려도 됩니다. 테이블은 읽기만 공개되어 있고,
> 쓰기는 호스트/참가자 비밀키를 확인하는 함수로만 가능합니다. `service_role` 키는 절대 넣지 마세요.

### 2. GitHub + Vercel
1. 이 폴더를 GitHub 저장소로 push
2. [vercel.com](https://vercel.com) → **Add New → Project** → 저장소 선택
3. Framework Preset: **Other**, Build Command 비움 → **Deploy**

### 로컬에서 미리 보기
```bash
npx serve .
```

## 파일 구조
```
index.html          화면 3개 (시작 / 진행 / 결과)
style.css           스타일 (다크 모드 지원)
app.js              로직, Supabase 실시간 구독
config.js           Supabase 주소와 키
supabase/schema.sql 테이블, 권한, 함수
```
