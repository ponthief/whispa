<template>
  <div class="terms-page">
    <div class="terms-col">

      <header class="terms-head">
        <img src="/icon.png" alt="" class="terms-mark" />
        <h1>Terms of Use</h1>
        <p class="text-dim text-sm">
          Version {{ version }} · {{ effective }}
        </p>
      </header>

      <section class="terms-lede">
        <p>
          WhiSPa is a self-custodial Bitcoin wallet built on Silent Payments.
          Reading this should take a few minutes, and it is written to be read
          rather than skipped. The short version: your keys are made on your
          own device and stay there, nobody operating this service can move
          your bitcoin, and nobody operating this service can get it back for
          you either.
        </p>
      </section>

      <section>
        <h2>1. What you are agreeing to</h2>
        <p>
          These terms cover your use of this WhiSPa instance — the web app, the
          mobile app, and the server behind them. By creating an account or
          using the software you accept them. If you do not, do not create an
          account; the software is open source and you are free to run your own
          copy under terms you set for yourself.
        </p>
        <p>
          You need to be old enough to enter a binding agreement where you
          live, and you must not be a person or entity that the operator is
          legally barred from serving. The operator may decline or close an
          account without having to justify the decision.
        </p>
      </section>

      <section>
        <h2>2. Open source, and what that means for you</h2>
        <p>
          WhiSPa is released under the
          <strong class="text-orange">MIT License</strong>. You may read, copy,
          modify, redistribute and run it, including commercially, provided the
          copyright notice and licence text travel with it. The source is
          public — you are not required to take anyone's word for what this
          software does, and you are encouraged not to.
        </p>
        <p>
          The MIT License also carries the warranty disclaimer that the rest of
          this document only restates: the software is provided
          <strong>“as is”</strong>, with no warranty of any kind, and the
          authors and copyright holders are not liable for any claim or damage
          arising from it. That is not boilerplate bolted on by us. It is the
          licence the software is distributed under, and it applies to this
          instance as much as to any other.
        </p>
      </section>

      <section>
        <h2>3. Your keys, and the one thing that cannot be undone</h2>
        <p>
          Your wallet is derived from a recovery phrase generated on your
          device. It is never transmitted to the server, and the server has no
          mechanism to request it. Transactions are built and signed on the
          device too. The practical consequence runs in both directions:
        </p>
        <ul>
          <li>
            Nobody running this service can spend your coins, freeze them,
            or hand them to anyone else.
          </li>
          <li>
            Nobody running this service can restore them. There is no reset,
            no support channel that can help, and no backup held on your
            behalf. <strong class="text-orange">If you lose your recovery
            phrase and lose your device, the bitcoin is gone permanently.</strong>
          </li>
        </ul>
        <p>
          Write the phrase down, keep it somewhere a fire or a flood will not
          reach, and never type it into anything that asks for it — including
          anyone claiming to be us. We will never ask for it.
        </p>
      </section>

      <section>
        <h2>4. Your account is not your wallet</h2>
        <p>
          The account — a username, an email address and a password — is how
          you reach this instance's services. The wallet is the keys on your
          device. They are separate things, and the distinction matters when
          something goes wrong.
        </p>
        <p>
          Losing access to your account, or having it closed, does not cost you
          your coins: your recovery phrase restores the wallet in any wallet
          that supports Silent Payments and BIP-84, here or elsewhere. Equally,
          keeping your account does not protect coins whose phrase you have
          lost.
        </p>
        <p>
          You are responsible for your password, for the security of the email
          address you register with, and for everything done through your
          account.
        </p>
      </section>

      <section>
        <h2>5. What the server stores</h2>
        <p>
          The server holds your username, the email address you registered
          with, a hash of your password, and the bookkeeping the wallet needs
          to work — which blocks have been scanned, which coins are known,
          labels you have chosen to sync. It does not hold keys, recovery
          phrases or passphrases.
        </p>
        <p>
          Your email address is used for verification, password resets and
          service notices. Push notifications, where you enable them, pass
          through the operating system vendor's delivery network, so they are
          deliberately vague: they tell you something happened without naming
          amounts.
        </p>
        <p>
          Addresses you label for your own reference, and the labels you attach
          to your plain SegWit addresses, stay on your device and are not sent
          anywhere.
        </p>
      </section>

      <section>
        <h2>6. Privacy is the point, but it is not a promise</h2>
        <p>
          Silent Payments mean the address you publish is not the address that
          appears on the chain, which removes the most common way payments get
          linked to each other and to you. The protocol does not make bitcoin
          anonymous, and neither do we. Chain analysis, the counterparty you
          transact with, your network path and your own habits can all
          undo it.
        </p>
        <p>
          Use a VPN or Tor if that matters to you. Register with a
          privacy-respecting or aliasing email provider if you prefer — we have
          no objection to either, and no interest in knowing more about you
          than the service needs.
        </p>
        <p>
          Where the software offers a cooperative transaction with another user
          to break the link between coins, it is cooperative by design: it
          needs a counterparty, it can fail or time out, and a round that does
          not complete returns your coins to you. If you have chosen to have
          the leftover change from such a round sent to a Lightning address
          instead of back into your wallet, that payment is attempted after the
          round confirms, is retried if it fails, and is reported to you either
          way.
        </p>
      </section>

      <section>
        <h2>7. Bitcoin, and what we are not</h2>
        <p>
          This is not a bank, a broker, an exchange or a custodian. No balance
          shown here is a deposit. There is no deposit insurance of any kind,
          from any scheme, in any jurisdiction. Bitcoin's price moves, and it
          can move against you.
        </p>
        <p>
          Bitcoin transactions are final. A payment sent to the wrong address,
          or at the wrong amount, cannot be recalled by us or by anyone else.
          Check what you are signing.
        </p>
        <p>
          Nothing in this software or its documentation is financial, legal or
          tax advice. What you owe, and to whom, is yours to work out.
        </p>
      </section>

      <section>
        <h2>8. Test networks hold nothing</h2>
        <p>
          Builds that run against Signet or other test networks use coins with
          no value whatsoever. They exist to let you try the software without
          risk. Do not treat a test-network balance as money, and do not send
          real bitcoin to an address a test build gave you.
        </p>
      </section>

      <section>
        <h2>9. Fair use</h2>
        <p>Do not use this service to:</p>
        <ul>
          <li>break the law where you are, or where the operator is;</li>
          <li>
            attack, overload, probe or reverse the infrastructure, or work
            around its rate limits;
          </li>
          <li>
            automate account creation, or register accounts on behalf of people
            who have not asked for them;
          </li>
          <li>
            impersonate anyone, or use the service to defraud another person.
          </li>
        </ul>
        <p>
          Studying the software, running your own instance, and reporting
          security problems are all explicitly welcome and are none of the
          above. If you find a vulnerability, please report it before
          publishing it.
        </p>
      </section>

      <section>
        <h2>10. Availability</h2>
        <p>
          This instance is offered without any guarantee of uptime. It may be
          slow, it may be interrupted for maintenance, it may break, and it may
          be shut down. Features may change or be withdrawn. The operator does
          not promise to keep running it and is not liable to you for the
          consequences of stopping.
        </p>
        <p>
          This is survivable precisely because the wallet is self-custodial: if
          this instance disappears tomorrow, your recovery phrase still opens
          your wallet somewhere else. That is the whole reason the design
          refuses to hold your keys.
        </p>
      </section>

      <section>
        <h2>11. Limits on liability</h2>
        <p>
          To the fullest extent the law allows, the operator, the authors and
          the contributors are not liable for lost bitcoin, lost profits, lost
          data, lost opportunity, or any indirect or consequential loss arising
          from your use of this software or service — including loss caused by
          a bug, by downtime, by a third-party service, by chain conditions, or
          by your own mistake.
        </p>
        <p>
          You agree to cover the operator for claims brought by others that
          arise from how you used the service or from your breach of these
          terms.
        </p>
      </section>

      <section>
        <h2>12. Closing your account</h2>
        <p>
          You can stop using the service at any time. Ask and your account and
          the server-side records tied to it will be removed. Because the
          server never had your keys, removing the account does not touch your
          coins — move them first if you want them somewhere else, and keep
          your recovery phrase regardless.
        </p>
        <p>
          Some records may survive in backups or logs for a period afterwards,
          and some may have to be kept where the law requires it.
        </p>
      </section>

      <section>
        <h2>13. Changes to these terms</h2>
        <p>
          These terms carry a version number, shown at the top of this page and
          recorded when you create an account. If they change in a way that
          matters, the version goes up and you will be asked to read them
          again. Continuing to use the service after a change means you accept
          the current version.
        </p>
      </section>

      <section>
        <h2>14. Governing law</h2>
        <p>
          These terms are governed by the laws of
          <span class="text-amber">{{ jurisdiction }}</span>, and disputes are
          subject to the courts of that jurisdiction, without regard to
          conflict-of-laws rules.
        </p>
      </section>

      <section>
        <h2>15. Getting in touch</h2>
        <p>
          Questions about these terms, the software, or your account:
          <span class="text-mono text-orange">{{ contact }}</span>.
        </p>
      </section>

      <footer class="terms-foot">
        <router-link to="/register" class="btn btn-primary">
          BACK TO SIGN UP
        </router-link>
        <router-link to="/login" class="text-dim text-sm">
          Already have an account? Sign in
        </router-link>
      </footer>

    </div>
  </div>
</template>

<script setup>
/*
 * The signup terms, as a route rather than a modal or a PDF.
 *
 * A ROUTE, because somebody who wants to read this before agreeing needs to be
 * able to open it in another tab, link to it, and come back to a form that
 * still has what they typed in it. A modal over the form loses the second of
 * those and a download loses all three.
 *
 * THE VERSION NUMBER IS THE LOAD-BEARING PART. The backend publishes the
 * current version through /auth/signup-config and refuses a registration that
 * claims a different one, so an account is tied to the text that was on screen
 * when it was made. The constant below must match helpers/terms.py in siLNt —
 * `npm run check:terms` fails when the two disagree, because a version bumped
 * on one side only reads as precision and is a lie.
 */
import { ref } from 'vue'

// Keep in step with siLNt's helpers/terms.py. See check:terms.
const version   = ref(1)
const effective = ref('2026-10-21')

// Placeholders the operator fills in. Deliberately rendered rather than left
// blank: a terms page with an empty governing-law clause is one nobody has
// read, and showing the gap is how it gets closed.
const jurisdiction = ref('the operator’s jurisdiction')
const contact      = ref('support@whispawallet.com')
</script>

<style scoped>
.terms-page {
  min-height: 100vh;
  background: var(--bg);
  padding: 32px 16px 64px;
}
/* A reading column, not a full-width page. Long prose set across a desktop
   monitor is measured in how little of it gets read. */
.terms-col { max-width: 680px; margin: 0 auto; }

.terms-head { text-align: center; margin-bottom: 28px; }
.terms-mark { width: 52px; height: 52px; border-radius: 12px; margin-bottom: 12px; }
.terms-head h1 { font-size: 24px; margin: 0 0 6px; }

.terms-lede {
  border: 1px solid var(--border);
  border-left: 3px solid var(--orange);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 28px;
}
.terms-lede p { margin: 0; }

.terms-col section { margin-bottom: 26px; }
.terms-col h2 {
  font-size: 15px;
  letter-spacing: .02em;
  color: var(--orange);
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.terms-col p { margin: 0 0 12px; line-height: 1.65; }
.terms-col p:last-child { margin-bottom: 0; }
.terms-col ul { margin: 0 0 12px; padding-left: 20px; line-height: 1.65; }
.terms-col li { margin-bottom: 6px; }

.terms-foot {
  margin-top: 36px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.terms-foot .btn { text-decoration: none; }
</style>
