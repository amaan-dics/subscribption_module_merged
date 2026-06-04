# -*- coding: utf-8 -*-
from odoo import http, fields
from odoo.http import request
from odoo.addons.payment_custom.controllers.main import CustomController
from odoo.addons.auth_signup.controllers.main import AuthSignupHome
from odoo.addons.payment.controllers.portal import PaymentPortal
import base64


class WebsiteHomeInherit(http.Controller):

    @http.route('/', type='http', auth='public', website=True)
    def homepage(self, **kwargs):
        user = request.env.user
        is_public = user._is_public()
        plans = request.env['subscription.package.plan'].sudo().search([])
        active_subscription = False
        current_plan_id = False
        remaining_days = 0
        amount = 0.00
        if not is_public:
            partner = user.partner_id
            active_subscription = request.env['subscription.package'].sudo().search([('partner_id', '=', partner.id),
                                                                                     ('stage_id.category', '=',
                                                                                      'progress')], limit=1)
            if active_subscription:
                current_plan_id = active_subscription.plan_id.id
                amount = active_subscription.total_recurring_price
                if partner.subscription_plan_id != active_subscription.plan_id:
                    partner.sudo().write({'subscription_plan_id': active_subscription.plan_id.id})
            else:
                partner.sudo().write({'subscription_plan_id': False})
            if active_subscription and active_subscription.next_invoice_date and active_subscription.start_date:
                exp_date = fields.Date.to_date(active_subscription.next_invoice_date)
                start_date = fields.Date.to_date(active_subscription.start_date)
                remaining_days = (exp_date - start_date).days
                if remaining_days < 0:
                    remaining_days = 0
        values = {'plans': plans, 'is_public': is_public, 'is_user': not is_public, 'amount': amount,
                  'active_subscription': active_subscription, 'current_plan_id': current_plan_id,
                  'remaining_days': remaining_days}
        return request.render('website.homepage', values)


class SignupExtended(AuthSignupHome):

        @http.route('/web/signup', type='http', auth='public', website=True, sitemap=False)
        def web_auth_signup(self, *args, **kw):
            kw['redirect'] = '/'
            response = super(SignupExtended, self).web_auth_signup(*args, **kw)
            if request.httprequest.method == 'POST':
                login = kw.get('login')
                selfie = kw.get('selfie')
                profile_pic = kw.get('profile_pic')
                id_proof = kw.get('id_proof')
                gender = kw.get('gender')
                age = kw.get('age')
                phone = kw.get('phone')
                address = kw.get('address')
                if login:
                    user = request.env['res.users'].sudo().search([('login', '=', login)], limit=1)
                    if user and user.partner_id:
                        vals = {
                            'kyc_status': 'pending',
                            'gender': gender,
                            'age': int(age) if age else False,
                            'phone': phone,
                            'address': address,
                        }
                        if selfie:
                            try:
                                if ',' in selfie:
                                    selfie_data = selfie.split(',')[1]
                                else:
                                    selfie_data = selfie
                                vals['selfie'] = selfie_data
                                vals['selfie_filename'] = 'selfie.png'
                            except Exception as e:
                                print("SELFIE ERROR:", e)
                                
                        if id_proof:
                            vals['id_proof'] = base64.b64encode(id_proof.read())
                            vals['id_proof_filename'] = id_proof.filename
                        if profile_pic:
                            vals['image_1920'] = base64.b64encode(profile_pic.read())
                        user.partner_id.sudo().write(vals)
                        return request.redirect('/')
            return response


class SelfieController(http.Controller):

    @http.route('/selfie-capture', type='http', auth='public', website=True)
    def selfie_page(self, **kw):
        return request.render('subscription_package_extended.selfie_capture_template')


class PortalNotificationController(http.Controller):

    @http.route('/portal/notifications', type='json', auth='user')
    def get_notifications(self):
        partner = request.env.user.partner_id
        notifs = request.env['portal.notification'].sudo().search([('partner_id', '=', partner.id),
                                                                   ('is_read', '=', False)])
        data = []
        for n in notifs:
            data.append({
                'id': n.id,
                'message': n.message,
                'from': n.ref_user_id.name if n.ref_user_id else 'User',
                'from_id': n.ref_user_id.id if n.ref_user_id else False,
            })
        notifs.write({'is_read': True})
        return {'notifications': data}
