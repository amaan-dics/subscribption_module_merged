# -*- coding: utf-8 -*-
from odoo import models, fields, api


class ResPartner(models.Model):
    _inherit = 'res.partner'

    gender = fields.Selection([('male', 'Male'), ('female', 'Female')], string="Gender")
    age = fields.Integer(string="Age")
    phone = fields.Char()
    address = fields.Text()
    kyc_status = fields.Selection([('pending', 'Pending'), ('approved', 'Approved'), ('rejected', 'Rejected')],
                                  default='pending', readonly=True)
    id_proof = fields.Binary("ID Proof")
    id_proof_filename = fields.Char()
    selfie = fields.Binary("Live Selfie")
    selfie_filename = fields.Char()
    subscription_plan_id = fields.Many2one('subscription.package.plan', string="Subscription Plan")
    connection_used = fields.Integer(compute="_compute_usage", string="Connections Used")
    chat_used = fields.Integer(compute="_compute_usage", string="Chats Used")


    def action_kyc_approved(self):
        self.kyc_status = 'approved'

    def action_kyc_rejected(self):
        self.kyc_status = 'rejected'

    @api.depends('subscription_plan_id', 'subscription_plan_id.connection_limit', 'subscription_plan_id.chat_limit')
    def _compute_usage(self):
        user_ids = self.ids
        connection_data = self.env['connect.request'].sudo().search([('state', '=', 'accepted'), '|',
                                                                     ('from_user_id', 'in', user_ids),
                                                                     ('to_user_id', 'in', user_ids)])
        conn_map = {uid: 0 for uid in user_ids}
        for rec in connection_data:
            if rec.from_user_id.id in conn_map:
                conn_map[rec.from_user_id.id] += 1
            if rec.to_user_id.id in conn_map:
                conn_map[rec.to_user_id.id] += 1
        channels = self.env['discuss.channel'].sudo().search([('channel_type', '=', 'chat'),
                                                              ('channel_partner_ids', 'in', user_ids)])
        chat_map = {uid: 0 for uid in user_ids}
        for channel in channels:
            for partner in channel.channel_partner_ids:
                if partner.id in chat_map:
                    chat_map[partner.id] += 1
        for rec in self:
            chat_count = chat_map.get(rec.id, 0)
            rec.connection_used = conn_map.get(rec.id, 0)
            rec.chat_used = max(chat_count - 1, 0)
