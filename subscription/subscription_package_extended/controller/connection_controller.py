# -*- coding: utf-8 -*-
from odoo import http, fields
from odoo.http import request
from markupsafe import escape


class SubscriptionMixin:

    def _check_and_sync_subscription(self, partner):
        active_subscription = request.env['subscription.package'].sudo().search([('partner_id', '=', partner.id),
                                                                                 ('stage_id.category', '=', 'progress')
                                                                                 ], limit=1)
        if active_subscription:
            if partner.subscription_plan_id != active_subscription.plan_id:
                partner.sudo().write({'subscription_plan_id': active_subscription.plan_id.id})
            return True
        else:
            # [CHANGE 1] Auto-assign free/trial plan (price=0) so users always have a plan context.
            # Previously this returned False and blocked all protected pages for unsubscribed users.
            free_plan = request.env['subscription.package.plan'].sudo().search(
                [('price', '=', 0)], limit=1
            )
            if free_plan:
                if partner.subscription_plan_id != free_plan:
                    partner.sudo().write({'subscription_plan_id': free_plan.id})
                return True
            # No free plan configured — clear plan and block access
            if partner.subscription_plan_id:
                partner.sudo().write({'subscription_plan_id': False})
            return False


class GenderMatchController(http.Controller, SubscriptionMixin):

    @http.route('/match', type='http', auth='user', website=True)
    def find_match(self, **kwargs):
        user = request.env.user
        partner = user.partner_id
        if not self._check_and_sync_subscription(partner):
            return request.render('subscription_package_extended.no_plan_template')
        if partner.kyc_status != 'approved':
            return request.render('subscription_package_extended.kyc_pending_template')
        opposite_gender = 'female' if partner.gender == 'male' else 'male'
        accepted_requests = request.env['connect.request'].sudo().search([('state', '=', 'accepted'), '|',
                                                                          ('from_user_id', '=', partner.id),
                                                                          ('to_user_id', '=', partner.id)])
        excluded_partner_ids = []
        for req in accepted_requests:
            if req.from_user_id.id == partner.id:
                excluded_partner_ids.append(req.to_user_id.id)
            else:
                excluded_partner_ids.append(req.from_user_id.id)
        users = request.env['res.partner'].sudo().search([('gender', '=', opposite_gender), ('id', '!=', partner.id),
                                                          ('id', 'not in', excluded_partner_ids),
                                                          ('kyc_status', '=', 'approved'), ('user_ids', '!=', False)])
        requests = request.env['connect.request'].sudo().search(['|', '&', ('from_user_id', '=', partner.id),
                                                                 ('to_user_id', 'in', users.ids), '&',
                                                                 ('from_user_id', 'in', users.ids),
                                                                 ('to_user_id', '=', partner.id)])
        req_map = {}
        for req in requests:
            if req.from_user_id.id == partner.id:
                req_map[req.to_user_id.id] = req
            else:
                req_map[req.from_user_id.id] = req
        values = {'users': users, 'current_user': partner, 'req_map': req_map}
        return request.render('subscription_package_extended.find_match_template', values)


class ConnectController(http.Controller, SubscriptionMixin):

    @http.route('/chat/<int:user_id>', type='http', auth='user', website=True)
    def chat_page(self, user_id, **kwargs):
        target = request.env['res.partner'].sudo().browse(user_id)
        return request.render('subscription_package_extended.chat_template', {'target_user': target})

    @http.route('/chat/send', type='json', auth='user')
    def send_message(self, user_id, message):
        current = request.env.user.partner_id
        target = request.env['res.partner'].sudo().browse(user_id)
        channel = request.env['discuss.channel'].sudo().search([('channel_type', '=', 'chat'),
                                                                ('channel_partner_ids', 'in', [current.id]),
                                                                ('channel_partner_ids', 'in', [target.id])])
        channel = channel.filtered(lambda c: len(c.channel_partner_ids) == 2)
        if not channel:
            channel = request.env['discuss.channel'].sudo().create({'channel_partner_ids': [(4, current.id),
                                                                                            (4, target.id)],
                                                                    'channel_type': 'chat',
                                                                    'name': f"{current.name}, {target.name}"})
        safe_msg = escape(message)
        channel.message_post(body=safe_msg, author_id=current.id, message_type='comment',
                             subtype_xmlid='mail.mt_comment')
        request.env['portal.notification'].sudo().create({'partner_id': target.id, 'message': safe_msg,
                                                          'ref_user_id': current.id})
        return {'status': 'ok'}

    @http.route('/chat/messages', type='json', auth='user')
    def get_messages(self, user_id):
        current = request.env.user.partner_id
        target = request.env['res.partner'].sudo().browse(int(user_id))
        channel = request.env['discuss.channel'].sudo().search([('channel_type', '=', 'chat'),
                                                                ('channel_partner_ids', 'in', [current.id]),
                                                                ('channel_partner_ids', 'in', [target.id])], limit=1)
        requiest_id = request.env['connect.request'].sudo().search([('to_user_id', '=', current.id),
                                                                    ('from_user_id', '=', int(user_id))], limit=1)

        # [CHANGE 3] Determine chat limit and whether this chat is within the allowed slots
        plan = current.subscription_plan_id
        chat_limit = plan.chat_limit if plan else 0
        all_channels = request.env['discuss.channel'].sudo().search([
            ('channel_type', '=', 'chat'),
            ('channel_partner_ids', 'in', [current.id])
        ])
        # Rank existing chat partners oldest-first so downgraded users keep their earliest chats
        all_channels_sorted = all_channels.sorted(key=lambda c: c.create_date)
        ranked_partner_ids = []
        for ch in all_channels_sorted:
            for p in ch.channel_partner_ids:
                if p.id != current.id and p.id not in ranked_partner_ids:
                    ranked_partner_ids.append(p.id)
        target_uid = int(user_id)
        is_new_chat = target_uid not in ranked_partner_ids
        chats_used = len(ranked_partner_ids)
        if chat_limit > 0 and not is_new_chat and target_uid in ranked_partner_ids:
            position = ranked_partner_ids.index(target_uid) + 1
            chat_limit_reached = position > chat_limit
        else:
            chat_limit_reached = chat_limit > 0 and is_new_chat and chats_used >= chat_limit

        if not channel:
            return {
                'messages': [],
                'channel_archived': False,
                'requiest_id_status': False,
                'chat_limit_reached': chat_limit_reached,  # [CHANGE 3]
            }
        msgs = channel.message_ids.filtered(lambda m: m.message_type == 'comment')
        result = []
        for m in msgs.sorted(key=lambda x: x.date):
            result.append({
                'body': m.body or '',
                'is_me': m.author_id.id == current.id,
                'date': m.date.strftime('%Y-%m-%d %H:%M:%S') if m.date else '',  # [CHANGE 2]
            })

        return {
            'messages': result,
            'requiest_id_status': requiest_id.state if requiest_id else False,
            'channel_archived': not channel.active,
            'channel_id': channel.id,
            'chat_limit_reached': chat_limit_reached,  # [CHANGE 3]
        }

    @http.route('/send_request/<int:user_id>', type='http', auth='user', website=True)
    def send_request(self, user_id, **kwargs):
        current_user = request.env.user.partner_id
        existing = request.env['connect.request'].sudo().search(['|', '&', ('from_user_id', '=', current_user.id),
                                                                 ('to_user_id', '=', user_id),
                                                                 '&', ('from_user_id', '=', user_id),
                                                                 ('to_user_id', '=', current_user.id)], limit=1)
        if not existing:
            req = request.env['connect.request'].sudo().create({'from_user_id': current_user.id, 'to_user_id': user_id})
            target = request.env['res.partner'].sudo().browse(user_id)
            if target.user_ids:
                request.env['bus.bus'].sudo()._sendone(target.id, 'connect_request', {'from': current_user.name,
                                                                                      'request_id': req.id})
        return request.redirect('/match')

    @http.route('/accept_request/<int:req_id>', type='http', auth='user', website=True)
    def accept_request(self, req_id, **kwargs):
        req = request.env['connect.request'].sudo().browse(req_id)
        req.state = 'accepted'
        reverse_req = request.env['connect.request'].sudo().search([('from_user_id', '=', req.to_user_id.id),
                                                                    ('to_user_id', '=', req.from_user_id.id)], limit=1)
        if not reverse_req:
            request.env['connect.request'].sudo().create({'from_user_id': req.to_user_id.id,
                                                          'to_user_id': req.from_user_id.id, 'state': 'accepted'})
        else:
            reverse_req.state = 'accepted'
        return request.redirect('/my_requests')

    @http.route('/reject_request/<int:req_id>', type='http', auth='user', website=True)
    def reject_request(self, req_id, **kwargs):
        req = request.env['connect.request'].sudo().browse(req_id)
        req.state = 'rejected'
        reverse_req = request.env['connect.request'].sudo().search([('from_user_id', '=', req.to_user_id.id),
                                                                    ('to_user_id', '=', req.from_user_id.id)], limit=1)
        if reverse_req:
            reverse_req.state = 'rejected'
        return request.redirect('/my_requests')

    @http.route('/my_requests', type='http', auth='user', website=True)
    def my_requests(self, **kwargs):
        user = request.env.user.partner_id
        if not self._check_and_sync_subscription(user):
            return request.render('subscription_package_extended.no_plan_template')
        if user.kyc_status != 'approved':
            return request.render('subscription_package_extended.kyc_pending_template')
        requests = request.env['connect.request'].sudo().search(
            [('to_user_id', '=', user.id), ('state', '=', 'pending')])
        # [CHANGE 5] Pass connection_limit_reached so template can lock Accept buttons
        plan = user.subscription_plan_id
        connection_limit = plan.connection_limit if plan else 0
        connection_limit_reached = connection_limit > 0 and (user.connection_used / 2) >= connection_limit

        return request.render('subscription_package_extended.request_template', {
            'requests': requests,
            'connection_limit_reached': connection_limit_reached,
        })

    @http.route('/chatbox', type='http', auth='user', website=True)
    def chatbox(self, user_id=None, **kwargs):
        current = request.env.user.partner_id
        if not self._check_and_sync_subscription(current):
            return request.render('subscription_package_extended.no_plan_template')
        if current.kyc_status != 'approved':
            return request.render('subscription_package_extended.kyc_pending_template')
        plan = current.subscription_plan_id
        chat_limit = plan.chat_limit if plan else 0
        if chat_limit == 0:
            return request.render('subscription_package_extended.chat_limit_reached_template')
        partner_ids = set()
        requests_data = request.env['connect.request'].sudo().search([('state', '=', 'accepted'), '|',
                                                                      ('from_user_id', '=', current.id),
                                                                      ('to_user_id', '=', current.id)])
        for req in requests_data:
            if req.from_user_id.id == current.id:
                partner_ids.add(req.to_user_id.id)
            else:
                partner_ids.add(req.from_user_id.id)
        channels = request.env['discuss.channel'].sudo().search([('channel_partner_ids', 'in', [current.id]),
                                                                 ('channel_type', '=', 'chat')])
        for channel in channels:
            for partner in channel.channel_partner_ids:
                if partner.id != current.id:
                    partner_ids.add(partner.id)
        partners = request.env['res.partner'].sudo().browse(list(partner_ids))
        selected_partner = False
        if user_id:
            selected_partner = request.env['res.partner'].sudo().browse(int(user_id))
        if not partners:
            return request.render('subscription_package_extended.no_chats_template')
        values = {'partners': partners, 'selected_partner': selected_partner}
        return request.render('subscription_package_extended.chatbox_template', values)


class ChatTermsController(http.Controller):
    @http.route('/chat/terms', type='json', auth='user')
    def get_terms(self, user_id=None):
        current = request.env.user.partner_id
        accepted = False
        if user_id:
            accepted = bool(request.env['chat.terms.acceptance'].sudo().search([('user_id', '=', current.id),
                                                                                ('partner_id', '=', int(user_id))],
                                                                               limit=1))
        terms = request.env['chat.terms'].sudo().search([('active', '=', True)], limit=1)
        return {'accepted': accepted, 'content': terms.content if terms else "", 'status': 'ok'}

    @http.route('/chat/terms/accept', type='json', auth='user')
    def accept_terms(self, user_id=None):
        current = request.env.user.partner_id
        if user_id:
            existing = request.env['chat.terms.acceptance'].sudo().search([('user_id', '=', current.id),
                                                                           ('partner_id', '=', int(user_id))], limit=1)
            if not existing:
                request.env['chat.terms.acceptance'].sudo().create({'user_id': current.id, 'partner_id': int(user_id),
                                                                    'accepted_date': fields.Datetime.now()})
        return {'status': 'ok'}

    @http.route('/chat/send', type='json', auth='user')
    def send_message(self, user_id, message):
        current = request.env.user.partner_id
        plan = current.subscription_plan_id
        chat_limit = plan.chat_limit if plan else 0
        if chat_limit == 0:
            return {'status': 'error', 'message': 'Your current plan does not include chat access'}

        accepted = request.env['chat.terms.acceptance'].sudo().search([('user_id', '=', current.id),
                                                                       ('partner_id', '=', int(user_id))], limit=1)
        if not accepted:
            return {'status': 'error', 'message': 'Please accept Terms & Conditions first'}
        target = request.env['res.partner'].sudo().browse(user_id)
        channel = request.env['discuss.channel'].sudo().search([('channel_type', '=', 'chat'),
                                                                ('channel_partner_ids', 'in', [current.id]),
                                                                ('channel_partner_ids', 'in', [target.id])])
        channel = channel.filtered(lambda c: len(c.channel_partner_ids) == 2)
        if not channel:
            channel = request.env['discuss.channel'].sudo().create({'channel_partner_ids': [(4, current.id),
                                                                                            (4, target.id)],
                                                                    'channel_type': 'chat',
                                                                    'name': f"{current.name}, {target.name}"})
        safe_msg = escape(message)
        channel.message_post(body=safe_msg, author_id=current.id, message_type='comment',
                             subtype_xmlid='mail.mt_comment')
        request.env['portal.notification'].sudo().create({'partner_id': target.id, 'message': safe_msg,
                                                          'ref_user_id': current.id})
        return {'status': 'ok'}

    @http.route('/chat/block_user', type='json', auth='user')
    def block_user(self, user_id):
        current = request.env.user.partner_id
        existing = request.env['chat.block.user'].sudo().search([('user_id', '=', current.id),
                                                                 ('blocked_user_id', '=', int(user_id))], limit=1)
        if not existing:
            request.env['chat.block.user'].sudo().create({'user_id': current.id, 'blocked_user_id': int(user_id)})
        return {'status': 'ok'}

    @http.route('/chat/toggle_block', type='json', auth='user')
    def toggle_block(self, user_id, action):
        current = request.env.user.partner_id
        target = request.env['res.partner'].sudo().browse(int(user_id))
        channel = request.env['discuss.channel'].sudo().with_context(active_test=False).search([
            ('channel_type', '=', 'chat'), ('channel_partner_ids', 'in', [current.id]),
            ('channel_partner_ids', 'in', [target.id])], limit=1)
        if not channel:
            return {'status': 'error'}
        if action == 'block':
            channel.write({'active': False})
        elif action == 'unblock':
            channel.write({'active': True})
        return {'status': 'ok'}